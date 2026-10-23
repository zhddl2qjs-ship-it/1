#include "SeatTracker.h"

#include <math.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#define SW_TRACKER_MAX_TRACKS (SW_TRACKER_MAX_SEATS * 2)
#define SW_REQUIRED_ABSENT_FRAMES 3

typedef struct {
    SWSeat seat;
    double last_seen;
    double missing_since;
    uint32_t consecutive;
    uint32_t absent_frames;
    int suppressed;
} Track;

struct SWTracker {
    Track *tracks;
    Track *spare;
    int32_t track_count;
    int32_t track_input[SW_TRACKER_MAX_TRACKS];
    int32_t input_track[SW_TRACKER_MAX_SEATS];
    unsigned char eligible[SW_TRACKER_MAX_SEATS];
    int newly_appeared_only;
    uint32_t confirmation_frames;
    double absence_seconds;
    double last_timestamp;
    int initialized;
};

SWTracker *sw_tracker_create(int32_t newly_appeared_only,
                             int32_t confirmation_frames,
                             double absence_seconds) {
    if ((newly_appeared_only != 0 && newly_appeared_only != 1) ||
        confirmation_frames < 1 || confirmation_frames > 30 ||
        !isfinite(absence_seconds) || absence_seconds < 0.0) {
        return NULL;
    }
    SWTracker *tracker = calloc(1, sizeof(*tracker));
    if (!tracker) return NULL;
    tracker->tracks = calloc(SW_TRACKER_MAX_TRACKS, sizeof(*tracker->tracks));
    tracker->spare = calloc(SW_TRACKER_MAX_TRACKS, sizeof(*tracker->spare));
    if (!tracker->tracks || !tracker->spare) {
        sw_tracker_destroy(tracker);
        return NULL;
    }
    tracker->newly_appeared_only = newly_appeared_only;
    tracker->confirmation_frames = (uint32_t)confirmation_frames;
    tracker->absence_seconds = absence_seconds;
    return tracker;
}

void sw_tracker_destroy(SWTracker *tracker) {
    if (!tracker) return;
    free(tracker->tracks);
    free(tracker->spare);
    free(tracker);
}

static int expired(const SWTracker *tracker, const Track *track, double now) {
    /* Keep short interruptions and deliberately long rearm intervals intact. */
    double retention = fmax(5.0, tracker->absence_seconds + 1.0);
    return track->absent_frames >= SW_REQUIRED_ABSENT_FRAMES &&
           now - track->missing_since > retention;
}

static int same_seat(const SWSeat *a, const SWSeat *b, double *distance) {
    double ratio = (double)a->diameter / (double)b->diameter;
    if (ratio < 0.70 || ratio > 1.40) return 0;
    double dx = (double)a->x - (double)b->x;
    double dy = (double)a->y - (double)b->y;
    double tolerance = fmax(3.0, 0.20 * fmin(a->diameter, b->diameter));
    *distance = dx * dx + dy * dy;
    return *distance <= tolerance * tolerance;
}

int32_t sw_tracker_update(SWTracker *tracker, const SWSeat *seats,
                          int32_t count, double timestamp, SWSeat *out) {
    if (!tracker || !out || count < 0 || count > SW_TRACKER_MAX_SEATS ||
        (count > 0 && !seats) || !isfinite(timestamp) || timestamp < 0.0 ||
        (tracker->initialized && timestamp <= tracker->last_timestamp)) {
        return -1;
    }
    for (int32_t i = 0; i < count; ++i) {
        if (seats[i].x < 0 || seats[i].y < 0 || seats[i].diameter < 1 ||
            seats[i].kind < 1 || seats[i].kind > 3) return -1;
    }

    /* Compute a complete assignment before committing any persistent state. */
    int32_t retained = 0;
    for (int32_t j = 0; j < tracker->track_count; ++j) {
        tracker->track_input[j] = -1;
        if (!expired(tracker, &tracker->tracks[j], timestamp)) ++retained;
    }
    int32_t new_tracks = 0;
    for (int32_t i = 0; i < count; ++i) {
        int32_t best = -1;
        double nearest = HUGE_VAL;
        tracker->eligible[i] = 0;
        for (int32_t j = 0; j < tracker->track_count; ++j) {
            const Track *track = &tracker->tracks[j];
            if (tracker->track_input[j] >= 0 || expired(tracker, track, timestamp))
                continue;
            double distance;
            if (same_seat(&seats[i], &track->seat, &distance) && distance < nearest) {
                nearest = distance;
                best = j;
            }
        }
        tracker->input_track[i] = best;
        if (best >= 0) tracker->track_input[best] = i;
        else ++new_tracks;
    }
    if (retained + new_tracks > SW_TRACKER_MAX_TRACKS) return -1;

    int32_t next_count = 0;
    for (int32_t j = 0; j < tracker->track_count; ++j) {
        Track next = tracker->tracks[j];
        if (expired(tracker, &next, timestamp)) continue;
        int32_t i = tracker->track_input[j];
        if (i >= 0) {
            if (next.suppressed && next.absent_frames >= SW_REQUIRED_ABSENT_FRAMES &&
                timestamp - next.missing_since >= tracker->absence_seconds) {
                next.suppressed = 0;
            }
            next.consecutive = next.absent_frames ? 1 : next.consecutive + 1;
            if (next.consecutive > tracker->confirmation_frames)
                next.consecutive = tracker->confirmation_frames;
            next.absent_frames = 0;
            next.missing_since = 0.0;
            next.last_seen = timestamp;
            next.seat = seats[i];
            tracker->eligible[i] = (unsigned char)(!next.suppressed &&
                next.consecutive >= tracker->confirmation_frames);
        } else {
            if (next.absent_frames == 0) next.missing_since = timestamp;
            if (next.absent_frames < UINT32_MAX) ++next.absent_frames;
            next.consecutive = 0;
        }
        tracker->spare[next_count++] = next;
    }
    for (int32_t i = 0; i < count; ++i) {
        if (tracker->input_track[i] >= 0) continue;
        Track next;
        memset(&next, 0, sizeof(next));
        next.seat = seats[i];
        next.last_seen = timestamp;
        next.consecutive = 1;
        next.suppressed = !tracker->initialized && tracker->newly_appeared_only;
        tracker->eligible[i] = (unsigned char)(!next.suppressed &&
            next.consecutive >= tracker->confirmation_frames);
        tracker->spare[next_count++] = next;
    }
    Track *old = tracker->tracks;
    tracker->tracks = tracker->spare;
    tracker->spare = old;
    tracker->track_count = next_count;
    tracker->last_timestamp = timestamp;
    tracker->initialized = 1;

    for (int32_t i = 0; i < count; ++i) {
        if (tracker->eligible[i]) {
            *out = seats[i];
            return 1;
        }
    }
    return 0;
}
