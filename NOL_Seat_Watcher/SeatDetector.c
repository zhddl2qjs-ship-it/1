#include "SeatDetector.h"

#include <limits.h>
#include <math.h>
#include <stddef.h>
#include <stdlib.h>

struct SWDetector {
    int32_t width;
    int32_t height;
    size_t pixels;
    uint8_t *mask;
    uint32_t *queue;
};

static int32_t minimum(int32_t a, int32_t b) { return a < b ? a : b; }
static int32_t maximum(int32_t a, int32_t b) { return a > b ? a : b; }

int32_t sw_classify_rgb(uint8_t red, uint8_t green, uint8_t blue) {
    const int32_t r = red, g = green, b = blue;
    const int32_t hi = maximum(r, maximum(g, b));
    const int32_t lo = minimum(r, minimum(g, b));
    const int32_t delta = hi - lo;
    /* Exclude gray, pale seat interiors and very dark text. */
    if (hi < 90 || delta < 35 || delta * 100 < hi * 30) return 0;

    int32_t hue;
    if (hi == r) {
        hue = 60 * (g - b) / delta;
        if (hue < 0) hue += 360;
    } else if (hi == g) {
        hue = 120 + 60 * (b - r) / delta;
    } else {
        hue = 240 + 60 * (r - g) / delta;
    }

    if (hue >= 75 && hue < 165) return 2;
    if (hue >= 180 && hue < 242) return 1;
    if (hue >= 242 && hue <= 305) return 3;
    return 0;
}

SWDetector *sw_detector_create(int32_t width, int32_t height) {
    if (width < 3 || height < 3 || width > 32768 || height > 32768) return NULL;
    const size_t pixels = (size_t)width * (size_t)height;
    /* Bound scratch memory to 160 MiB and indices to uint32_t. */
    if (pixels > 32u * 1024u * 1024u) return NULL;
    SWDetector *detector = calloc(1, sizeof(*detector));
    if (!detector) return NULL;
    detector->mask = malloc(pixels);
    detector->queue = malloc(pixels * sizeof(*detector->queue));
    if (!detector->mask || !detector->queue) {
        sw_detector_destroy(detector);
        return NULL;
    }
    detector->width = width;
    detector->height = height;
    detector->pixels = pixels;
    return detector;
}

void sw_detector_destroy(SWDetector *detector) {
    if (!detector) return;
    free(detector->mask);
    free(detector->queue);
    free(detector);
}

static int ring_geometry(const SWDetector *detector, size_t count, uint8_t kind,
                         int32_t min_x, int32_t max_x,
                         int32_t min_y, int32_t max_y,
                         uint64_t sum_x, uint64_t sum_y) {
    const int32_t width = max_x - min_x + 1, height = max_y - min_y + 1;
    const double ratio = (double)width / (double)height;
    if (ratio < 0.80 || ratio > 1.25) return 0;
    const double density = (double)count / ((double)width * (double)height);
    /* A perimeter-dependent minimum allows large, thin outlines. */
    if (count < 12 || (double)count < (double)(width + height) * 0.45 ||
        density > 0.70) return 0;

    const double cx = (min_x + max_x) * 0.5;
    const double cy = (min_y + max_y) * 0.5;
    const double rx = (width - 1) * 0.5;
    const double ry = (height - 1) * 0.5;
    const int32_t center_x = (int32_t)lround(cx);
    const int32_t center_y = (int32_t)lround(cy);
    if ((detector->mask[(size_t)center_y * detector->width + center_x] & 0x7fu) != 0)
        return 0;
    if (fabs((double)sum_x / count - cx) > fmax(1.5, width * 0.09) ||
        fabs((double)sum_y / count - cy) > fmax(1.5, height * 0.09)) return 0;

    size_t interior = 0, outside = 0;
    for (size_t i = 0; i < count; ++i) {
        const uint32_t index = detector->queue[i];
        const double dx = ((double)(index % (uint32_t)detector->width) - cx) / rx;
        const double dy = ((double)(index / (uint32_t)detector->width) - cy) / ry;
        const double distance2 = dx * dx + dy * dy;
        if (distance2 < 0.36) ++interior;
        if (distance2 > 1.21) ++outside;
    }
    /* Reject filled shapes, letters with interior strokes and rectangular borders. */
    if (interior * 100 > count * 8 || outside * 100 > count * 8) return 0;

    static const double unit_x[16] = {
        1.0, 0.9238795325, 0.7071067812, 0.3826834324,
        0.0, -0.3826834324, -0.7071067812, -0.9238795325,
        -1.0, -0.9238795325, -0.7071067812, -0.3826834324,
        0.0, 0.3826834324, 0.7071067812, 0.9238795325
    };
    static const double unit_y[16] = {
        0.0, 0.3826834324, 0.7071067812, 0.9238795325,
        1.0, 0.9238795325, 0.7071067812, 0.3826834324,
        0.0, -0.3826834324, -0.7071067812, -0.9238795325,
        -1.0, -0.9238795325, -0.7071067812, -0.3826834324
    };
    int covered = 0;
    const double step = 1.0 / fmax(rx, ry);
    for (int direction = 0; direction < 16; ++direction) {
        int found = 0;
        /* Search the actual outline band, not one radius with a fixed tolerance. */
        for (double radius = 1.03; radius >= 0.60 && !found; radius -= step) {
            const int32_t x = (int32_t)lround(cx + rx * radius * unit_x[direction]);
            const int32_t y = (int32_t)lround(cy + ry * radius * unit_y[direction]);
            for (int32_t dy = -1; dy <= 1 && !found; ++dy) {
                for (int32_t dx = -1; dx <= 1; ++dx) {
                    const int32_t tx = x + dx, ty = y + dy;
                    if (tx < min_x || tx > max_x || ty < min_y || ty > max_y) continue;
                    if ((detector->mask[(size_t)ty * detector->width + tx] & 0x7fu) == kind) {
                        found = 1;
                        break;
                    }
                }
            }
        }
        covered += found;
    }
    return covered >= 14;
}

int32_t sw_detector_scan(SWDetector *detector, const uint8_t *bgra,
                         int32_t bytes_per_row, uint32_t enabled_colors,
                         int32_t min_diameter, int32_t max_diameter,
                         SWSeat *out, int32_t capacity) {
    if (!detector || !bgra || !out || capacity < 1 ||
        bytes_per_row < detector->width * 4 ||
        min_diameter < 5 || max_diameter < min_diameter || max_diameter > 32768 ||
        (enabled_colors & ~7u) != 0) return -1;

    const int32_t width = detector->width, height = detector->height;
    for (int32_t y = 0; y < height; ++y) {
        const uint8_t *row = bgra + (size_t)y * (size_t)bytes_per_row;
        for (int32_t x = 0; x < width; ++x) {
            const uint8_t *pixel = row + (size_t)x * 4u;
            const int32_t kind = sw_classify_rgb(pixel[2], pixel[1], pixel[0]);
            detector->mask[(size_t)y * width + x] =
                kind && (enabled_colors & (1u << (kind - 1))) ? (uint8_t)kind : 0;
        }
    }

    int32_t found = 0;
    for (size_t start = 0; start < detector->pixels; ++start) {
        const uint8_t kind = detector->mask[start];
        if (kind == 0 || (kind & 0x80u) != 0) continue;
        size_t count = 1, front = 0;
        detector->queue[0] = (uint32_t)start;
        detector->mask[start] |= 0x80u;
        int32_t min_x = (int32_t)(start % (size_t)width), max_x = min_x;
        int32_t min_y = (int32_t)(start / (size_t)width), max_y = min_y;
        uint64_t sum_x = 0, sum_y = 0;

        while (front < count) {
            const uint32_t index = detector->queue[front++];
            const int32_t x = (int32_t)(index % (uint32_t)width);
            const int32_t y = (int32_t)(index / (uint32_t)width);
            min_x = minimum(min_x, x); max_x = maximum(max_x, x);
            min_y = minimum(min_y, y); max_y = maximum(max_y, y);
            sum_x += (uint32_t)x; sum_y += (uint32_t)y;
            for (int32_t ny = maximum(0, y - 1); ny <= minimum(height - 1, y + 1); ++ny) {
                for (int32_t nx = maximum(0, x - 1); nx <= minimum(width - 1, x + 1); ++nx) {
                    const size_t neighbor = (size_t)ny * width + nx;
                    if (detector->mask[neighbor] == kind) {
                        detector->mask[neighbor] |= 0x80u;
                        detector->queue[count++] = (uint32_t)neighbor;
                    }
                }
            }
        }

        const int32_t w = max_x - min_x + 1, h = max_y - min_y + 1;
        if (min_x == 0 || min_y == 0 || max_x == width - 1 || max_y == height - 1 ||
            w < min_diameter || h < min_diameter ||
            w > max_diameter || h > max_diameter) continue;
        if (!ring_geometry(detector, count, kind, min_x, max_x, min_y, max_y, sum_x, sum_y))
            continue;
        if (found >= capacity) return -2;
        out[found].x = (min_x + max_x + 1) / 2;
        out[found].y = (min_y + max_y + 1) / 2;
        out[found].diameter = (w + h + 1) / 2;
        out[found].kind = kind;
        ++found;
    }
    return found;
}
