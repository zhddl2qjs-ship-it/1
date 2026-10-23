#ifndef SEAT_DETECTOR_H
#define SEAT_DETECTOR_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct SWDetector SWDetector;

typedef struct {
    int32_t x;
    int32_t y;
    int32_t diameter;
    int32_t kind; /* 1 = blue, 2 = green, 3 = purple */
} SWSeat;

/* Each context is owned by one serial analysis queue; do not use concurrently. */
SWDetector *sw_detector_create(int32_t width, int32_t height);
void sw_detector_destroy(SWDetector *detector);

/*
 * Input: top-left-oriented BGRA bytes. bytes_per_row may include padding.
 * enabled_colors: bit 0 blue, bit 1 green, bit 2 purple.
 * Output: all complete circular ring candidates, in image scan order.
 * Return >= 0 candidate count, -1 invalid arguments, -2 output too small.
 * If negative, do not use any output entries. No allocations occur in scan.
 * Objects touching a crop edge are rejected: select a small margin around seats.
 */
int32_t sw_detector_scan(SWDetector *detector, const uint8_t *bgra,
                         int32_t bytes_per_row, uint32_t enabled_colors,
                         int32_t min_diameter, int32_t max_diameter,
                         SWSeat *out, int32_t capacity);

/* Classification is independent of the enabled colors. Zero means no match. */
int32_t sw_classify_rgb(uint8_t r, uint8_t g, uint8_t b);

#ifdef __cplusplus
}
#endif

#endif
