#include "../SeatTracker.h"

#include <math.h>
#include <stdio.h>
#include <stdlib.h>

static int checks = 0;
#define CHECK(condition) do { \
    ++checks; \
    if (!(condition)) { \
        fprintf(stderr, "FAIL %s:%d: %s\n", __FILE__, __LINE__, #condition); \
        exit(1); \
    } \
} while (0)

static SWSeat seat(int32_t x, int32_t y, int32_t diameter, int32_t kind) {
    SWSeat s = {x, y, diameter, kind};
    return s;
}

static SWTracker *make_tracker(int new_only) {
    SWTracker *tracker = sw_tracker_create(new_only, 2, 0.35);
    CHECK(tracker != NULL);
    return tracker;
}

static void existing_seat_confirms(void) {
    SWTracker *t = make_tracker(0);
    SWSeat s = seat(20, 50, 21, 1), out = {0};
    CHECK(sw_tracker_update(t, &s, 1, 1.0, &out) == 0);
    CHECK(sw_tracker_update(t, &s, 1, 1.04, &out) == 1);
    CHECK(out.x == 20 && out.y == 50 && out.kind == 1);
    sw_tracker_destroy(t);
}

static void initial_seats_suppressed(void) {
    SWTracker *t = make_tracker(1);
    SWSeat s = seat(20, 50, 21, 1), out = {0};
    CHECK(sw_tracker_update(t, &s, 1, 1.0, &out) == 0);
    for (int i = 1; i <= 20; ++i)
        CHECK(sw_tracker_update(t, &s, 1, 1.0 + i * 0.04, &out) == 0);
    sw_tracker_destroy(t);
}

static void newly_visible_seat_confirms(void) {
    SWTracker *t = make_tracker(1);
    SWSeat s = seat(20, 50, 21, 1), out = {0};
    CHECK(sw_tracker_update(t, NULL, 0, 1.0, &out) == 0);
    CHECK(sw_tracker_update(t, &s, 1, 1.04, &out) == 0);
    CHECK(sw_tracker_update(t, &s, 1, 1.08, &out) == 1);
    sw_tracker_destroy(t);
}

static void disappearance_rearms_initial_seat(void) {
    SWTracker *t = make_tracker(1);
    SWSeat s = seat(20, 50, 21, 1), out = {0};
    CHECK(sw_tracker_update(t, &s, 1, 1.0, &out) == 0);
    CHECK(sw_tracker_update(t, NULL, 0, 1.1, &out) == 0);
    CHECK(sw_tracker_update(t, NULL, 0, 1.2, &out) == 0);
    CHECK(sw_tracker_update(t, NULL, 0, 1.3, &out) == 0);
    CHECK(sw_tracker_update(t, &s, 1, 1.5, &out) == 0);
    CHECK(sw_tracker_update(t, &s, 1, 1.54, &out) == 1);
    sw_tracker_destroy(t);
}

static void brief_flicker_keeps_initial_suppression(void) {
    SWTracker *t = make_tracker(1);
    SWSeat s = seat(20, 50, 21, 1), out = {0};
    CHECK(sw_tracker_update(t, &s, 1, 1.0, &out) == 0);
    CHECK(sw_tracker_update(t, NULL, 0, 1.04, &out) == 0);
    CHECK(sw_tracker_update(t, NULL, 0, 1.08, &out) == 0);
    CHECK(sw_tracker_update(t, NULL, 0, 1.12, &out) == 0);
    CHECK(sw_tracker_update(t, &s, 1, 1.16, &out) == 0);
    CHECK(sw_tracker_update(t, &s, 1, 1.20, &out) == 0);
    sw_tracker_destroy(t);
}

static void one_long_missing_observation_does_not_rearm(void) {
    SWTracker *t = make_tracker(1);
    SWSeat s = seat(20, 50, 21, 1), out = {0};
    CHECK(sw_tracker_update(t, &s, 1, 1.0, &out) == 0);
    CHECK(sw_tracker_update(t, NULL, 0, 2.0, &out) == 0);
    CHECK(sw_tracker_update(t, &s, 1, 3.0, &out) == 0);
    CHECK(sw_tracker_update(t, &s, 1, 3.04, &out) == 0);
    sw_tracker_destroy(t);
}

static void initial_gap_timing_uses_first_absence(void) {
    SWTracker *t = make_tracker(1);
    SWSeat s = seat(20, 50, 21, 1), out = {0};
    CHECK(sw_tracker_update(t, &s, 1, 1.0, &out) == 0);
    CHECK(sw_tracker_update(t, NULL, 0, 1.4, &out) == 0);
    CHECK(sw_tracker_update(t, NULL, 0, 1.44, &out) == 0);
    CHECK(sw_tracker_update(t, NULL, 0, 1.48, &out) == 0);
    CHECK(sw_tracker_update(t, &s, 1, 1.52, &out) == 0);
    CHECK(sw_tracker_update(t, &s, 1, 1.56, &out) == 0);
    sw_tracker_destroy(t);
}

static void one_frame_noise_does_not_trigger(void) {
    SWTracker *t = make_tracker(0);
    SWSeat s = seat(20, 50, 21, 1), out = {0};
    CHECK(sw_tracker_update(t, &s, 1, 1.0, &out) == 0);
    CHECK(sw_tracker_update(t, NULL, 0, 1.04, &out) == 0);
    CHECK(sw_tracker_update(t, &s, 1, 1.08, &out) == 0);
    CHECK(sw_tracker_update(t, NULL, 0, 1.12, &out) == 0);
    sw_tracker_destroy(t);
}

static void jitter_and_color_changes_keep_identity(void) {
    SWTracker *t = make_tracker(1);
    SWSeat s = seat(20, 50, 21, 1), out = {0};
    CHECK(sw_tracker_update(t, &s, 1, 1.0, &out) == 0);
    s = seat(22, 51, 23, 3);
    CHECK(sw_tracker_update(t, &s, 1, 1.04, &out) == 0);
    s = seat(20, 50, 21, 2);
    CHECK(sw_tracker_update(t, &s, 1, 1.08, &out) == 0);
    sw_tracker_destroy(t);
}

static void restarted_tracker_has_fresh_baseline(void) {
    SWSeat s = seat(20, 50, 21, 1), out = {0};
    SWTracker *t = make_tracker(1);
    CHECK(sw_tracker_update(t, NULL, 0, 1.0, &out) == 0);
    CHECK(sw_tracker_update(t, &s, 1, 1.04, &out) == 0);
    sw_tracker_destroy(t);
    t = make_tracker(1);
    CHECK(sw_tracker_update(t, &s, 1, 2.0, &out) == 0);
    CHECK(sw_tracker_update(t, &s, 1, 2.04, &out) == 0);
    sw_tracker_destroy(t);
}

static void input_order_selects_candidate(void) {
    SWTracker *t = make_tracker(0);
    SWSeat seats[] = {{120, 50, 21, 2}, {20, 50, 21, 1}}, out = {0};
    CHECK(sw_tracker_update(t, seats, 2, 1.0, &out) == 0);
    CHECK(sw_tracker_update(t, seats, 2, 1.04, &out) == 1);
    CHECK(out.x == 120 && out.kind == 2);
    sw_tracker_destroy(t);
}

static void neighboring_seats_stay_distinct(void) {
    SWTracker *t = make_tracker(1);
    SWSeat seats[] = {{20, 50, 21, 1}, {45, 50, 21, 1}}, out = {0};
    CHECK(sw_tracker_update(t, seats, 1, 1.0, &out) == 0);
    CHECK(sw_tracker_update(t, seats, 2, 1.04, &out) == 0);
    CHECK(sw_tracker_update(t, seats, 2, 1.08, &out) == 1);
    CHECK(out.x == 45);
    sw_tracker_destroy(t);
}

static void expired_absent_tracks_can_return(void) {
    SWTracker *t = make_tracker(1);
    SWSeat s = seat(20, 50, 21, 1), out = {0};
    CHECK(sw_tracker_update(t, &s, 1, 1.0, &out) == 0);
    CHECK(sw_tracker_update(t, NULL, 0, 1.1, &out) == 0);
    CHECK(sw_tracker_update(t, NULL, 0, 1.2, &out) == 0);
    CHECK(sw_tracker_update(t, NULL, 0, 1.3, &out) == 0);
    CHECK(sw_tracker_update(t, NULL, 0, 8.0, &out) == 0);
    CHECK(sw_tracker_update(t, &s, 1, 8.04, &out) == 0);
    CHECK(sw_tracker_update(t, &s, 1, 8.08, &out) == 1);
    sw_tracker_destroy(t);
}

static void invalid_inputs_do_not_commit_state(void) {
    SWTracker *t = make_tracker(0);
    SWSeat s = seat(20, 50, 21, 1), bad = seat(20, 50, 21, 0);
    SWSeat out = seat(123, 456, 21, 3);
    CHECK(sw_tracker_update(NULL, &s, 1, 1.0, &out) == -1);
    CHECK(sw_tracker_update(t, NULL, 1, 1.0, &out) == -1);
    CHECK(sw_tracker_update(t, &s, -1, 1.0, &out) == -1);
    CHECK(sw_tracker_update(t, &s, SW_TRACKER_MAX_SEATS + 1, 1.0, &out) == -1);
    CHECK(sw_tracker_update(t, &s, 1, NAN, &out) == -1);
    CHECK(sw_tracker_update(t, &s, 1, INFINITY, &out) == -1);
    CHECK(sw_tracker_update(t, &s, 1, -1.0, &out) == -1);
    CHECK(sw_tracker_update(t, &bad, 1, 1.0, &out) == -1);
    CHECK(sw_tracker_update(t, &s, 1, 1.0, NULL) == -1);
    CHECK(out.x == 123 && out.y == 456 && out.kind == 3);
    CHECK(sw_tracker_update(t, &s, 1, 1.0, &out) == 0);
    CHECK(sw_tracker_update(t, &s, 1, 0.9, &out) == -1);
    CHECK(sw_tracker_update(t, &s, 1, 1.0, &out) == -1);
    CHECK(sw_tracker_update(t, &bad, 1, 1.04, &out) == -1);
    CHECK(sw_tracker_update(t, &s, 1, 1.04, &out) == 1);
    sw_tracker_destroy(t);
}

static void creation_validation(void) {
    CHECK(sw_tracker_create(-1, 2, 0.35) == NULL);
    CHECK(sw_tracker_create(2, 2, 0.35) == NULL);
    CHECK(sw_tracker_create(1, 0, 0.35) == NULL);
    CHECK(sw_tracker_create(1, 31, 0.35) == NULL);
    CHECK(sw_tracker_create(1, 2, NAN) == NULL);
    CHECK(sw_tracker_create(1, 2, INFINITY) == NULL);
    CHECK(sw_tracker_create(1, 2, -0.1) == NULL);
    sw_tracker_destroy(NULL);
}

int main(void) {
    creation_validation();
    existing_seat_confirms();
    initial_seats_suppressed();
    newly_visible_seat_confirms();
    disappearance_rearms_initial_seat();
    brief_flicker_keeps_initial_suppression();
    one_long_missing_observation_does_not_rearm();
    initial_gap_timing_uses_first_absence();
    one_frame_noise_does_not_trigger();
    jitter_and_color_changes_keep_identity();
    restarted_tracker_has_fresh_baseline();
    input_order_selects_candidate();
    neighboring_seats_stay_distinct();
    expired_absent_tracks_can_return();
    invalid_inputs_do_not_commit_state();
    printf("PASS tracker: 15 scenarios, %d assertions\n", checks);
    return 0;
}
