#ifndef SEAT_TRACKER_H
#define SEAT_TRACKER_H

#include "SeatDetector.h"

#ifdef __cplusplus
extern "C" {
#endif

#define SW_TRACKER_MAX_SEATS 4096

typedef struct SWTracker SWTracker;

/* One tracker belongs to one capture run and one serial analysis queue. */
SWTracker *sw_tracker_create(int32_t newly_appeared_only,
                             int32_t confirmation_frames,
                             double absence_seconds);
void sw_tracker_destroy(SWTracker *tracker);

/*
 * Input is the entire detected seat list for a complete/unchanged frame, in
 * preferred selection order. Timestamps must be finite, nonnegative, strictly
 * increasing monotonic seconds. A zero count may have a NULL seats pointer.
 *
 * Initial seats are suppressed in new-only mode. A suppressed seat is rearmed
 * only after at least three absent observations AND absence_seconds since its
 * first absent observation. Reappearance still needs confirmation_frames
 * consecutive observations. Identity uses position/diameter, not color.
 *
 * Return 1 and write one confirmed candidate; return 0 for no candidate; return
 * -1 on invalid input or capacity exhaustion. On -1 state/output are unchanged.
 * The output pointer is always required. No allocation occurs during updates.
 * Stop/reset by destroying this tracker and creating a new instance.
 */
int32_t sw_tracker_update(SWTracker *tracker, const SWSeat *seats,
                          int32_t count, double timestamp, SWSeat *out);

#ifdef __cplusplus
}
#endif

#endif
