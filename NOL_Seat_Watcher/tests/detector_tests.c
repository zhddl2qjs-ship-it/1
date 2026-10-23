#include "../SeatDetector.h"

#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef struct { uint8_t r, g, b; } Color;
typedef struct { int32_t width, height, stride; uint8_t *data; } Image;

static const Color BLUE = {83, 176, 249};
static const Color GREEN = {79, 166, 52};
static const Color PURPLE = {121, 105, 230};
static const Color GRAY = {170, 170, 170};
static const Color PALE = {221, 229, 249};
static int checks, failures;

#define CHECK(condition, label) do { \
    ++checks; \
    if (!(condition)) { \
        ++failures; \
        fprintf(stderr, "FAIL: %s (%s:%d)\n", label, __FILE__, __LINE__); \
    } \
} while (0)

static Image image_new(int32_t width, int32_t height, int32_t padding) {
    Image image = {width, height, width * 4 + padding, NULL};
    image.data = malloc((size_t)image.stride * height);
    if (!image.data) { fputs("Fixture allocation failed\n", stderr); exit(2); }
    return image;
}

static void image_clear(Image *image) {
    /* Padding has a vivid color pattern, so treating stride as width*4 fails. */
    memset(image->data, 83, (size_t)image->stride * image->height);
    for (int32_t y = 0; y < image->height; ++y) {
        for (int32_t x = 0; x < image->width; ++x) {
            uint8_t *pixel = image->data + (size_t)y * image->stride + x * 4;
            pixel[0] = pixel[1] = pixel[2] = 245;
            pixel[3] = 255;
        }
    }
}

static void paint(Image *image, int32_t x, int32_t y, Color color) {
    if (x < 0 || y < 0 || x >= image->width || y >= image->height) return;
    uint8_t *pixel = image->data + (size_t)y * image->stride + x * 4;
    pixel[0] = color.b; pixel[1] = color.g; pixel[2] = color.r; pixel[3] = 255;
}

static void ring(Image *image, int32_t cx, int32_t cy,
                 int32_t diameter, double thickness, Color color) {
    const double outer = (diameter - 1) * 0.5;
    const double inner = fmax(0.0, outer - thickness);
    for (int32_t y = 0; y < image->height; ++y) {
        for (int32_t x = 0; x < image->width; ++x) {
            const double dx = x - cx, dy = y - cy;
            const double distance2 = dx * dx + dy * dy;
            if (distance2 <= outer * outer && distance2 >= inner * inner)
                paint(image, x, y, color);
        }
    }
}

static void square_border(Image *image, int32_t cx, int32_t cy,
                          int32_t side, int32_t thickness, Color color) {
    const int32_t radius = side / 2;
    for (int32_t y = -radius; y <= radius; ++y)
        for (int32_t x = -radius; x <= radius; ++x)
            if (abs(x) > radius - thickness || abs(y) > radius - thickness)
                paint(image, cx + x, cy + y, color);
}

/* Render geometry independently of detector thresholds, with 8x8 coverage AA. */
static void supersampled_ring(Image *image, double cx, double cy,
                               double diameter_x, double diameter_y,
                               double thickness, Color color) {
    enum { SAMPLES = 8, TOTAL = SAMPLES * SAMPLES };
    const double outer_x = diameter_x * 0.5, outer_y = diameter_y * 0.5;
    const double inner_x = outer_x - thickness, inner_y = outer_y - thickness;
    for (int32_t y = 0; y < image->height; ++y) {
        if (fabs(y - cy) > outer_y + 1.0) continue;
        for (int32_t x = 0; x < image->width; ++x) {
            if (fabs(x - cx) > outer_x + 1.0) continue;
            int coverage = 0;
            for (int sy = 0; sy < SAMPLES; ++sy) {
                for (int sx = 0; sx < SAMPLES; ++sx) {
                    const double dx = x + (sx + 0.5) / SAMPLES - 0.5 - cx;
                    const double dy = y + (sy + 0.5) / SAMPLES - 0.5 - cy;
                    const double outer = dx * dx / (outer_x * outer_x) +
                                         dy * dy / (outer_y * outer_y);
                    const double inner = dx * dx / (inner_x * inner_x) +
                                         dy * dy / (inner_y * inner_y);
                    if (outer <= 1.0 && inner >= 1.0) ++coverage;
                }
            }
            if (coverage == 0) continue;
            const Color blended = {
                (uint8_t)((color.r * coverage + 245 * (TOTAL - coverage) + TOTAL / 2) / TOTAL),
                (uint8_t)((color.g * coverage + 245 * (TOTAL - coverage) + TOTAL / 2) / TOTAL),
                (uint8_t)((color.b * coverage + 245 * (TOTAL - coverage) + TOTAL / 2) / TOTAL)
            };
            paint(image, x, y, blended);
        }
    }
}

static int32_t scan(SWDetector *detector, Image *image, uint32_t flags,
                    SWSeat *out, int32_t capacity) {
    return sw_detector_scan(detector, image->data, image->stride,
                            flags, 9, 240, out, capacity);
}

static void expect_seat(SWSeat seat, int32_t x, int32_t y,
                        int32_t diameter, int32_t kind, const char *name) {
    CHECK(seat.x == x, name);
    CHECK(seat.y == y, name);
    CHECK(seat.diameter == diameter, name);
    CHECK(seat.kind == kind, name);
}

static void color_cases(void) {
    CHECK(sw_classify_rgb(BLUE.r, BLUE.g, BLUE.b) == 1, "blue sample class");
    CHECK(sw_classify_rgb(GREEN.r, GREEN.g, GREEN.b) == 2, "green sample class");
    CHECK(sw_classify_rgb(PURPLE.r, PURPLE.g, PURPLE.b) == 3, "purple sample class");
    CHECK(sw_classify_rgb(170, 170, 170) == 0, "gray is not a seat color");
    CHECK(sw_classify_rgb(221, 229, 249) == 0, "pale center is not a seat color");
    CHECK(sw_classify_rgb(10, 10, 60) == 0, "dark text is not a seat color");
    CHECK(sw_classify_rgb(230, 50, 30) == 0, "red not enabled seat family");

    Image image = image_new(180, 120, 28);
    image_clear(&image);
    SWDetector *detector = sw_detector_create(image.width, image.height);
    CHECK(detector != NULL, "color detector allocation");
    if (!detector) exit(2);
    ring(&image, 25, 22, 21, 2, BLUE);
    ring(&image, 78, 58, 21, 2, GREEN);
    ring(&image, 142, 91, 21, 2, PURPLE);
    for (uint32_t flags = 0; flags < 8; ++flags) {
        SWSeat out[4];
        const int32_t actual = scan(detector, &image, flags, out, 4);
        const int32_t expected = ((flags & 1u) != 0) + ((flags & 2u) != 0) + ((flags & 4u) != 0);
        CHECK(actual == expected, "all color checkbox combinations");
        if (actual != expected) continue;
        int32_t index = 0;
        if (flags & 1u) expect_seat(out[index++], 25, 22, 21, 1, "blue checkbox result");
        if (flags & 2u) expect_seat(out[index++], 78, 58, 21, 2, "green checkbox result");
        if (flags & 4u) expect_seat(out[index++], 142, 91, 21, 3, "purple checkbox result");
    }
    sw_detector_destroy(detector);
    free(image.data);
}

static void size_cases(void) {
    static const struct { int32_t diameter; double thickness; } cases[] = {
        {9, 1}, {11, 1}, {21, 1}, {21, 2}, {51, 1}, {51, 3},
        {101, 1}, {101, 2}, {101, 4}, {101, 5}, {161, 2}, {201, 2}, {201, 6}
    };
    Image image = image_new(270, 260, 12);
    SWDetector *detector = sw_detector_create(image.width, image.height);
    CHECK(detector != NULL, "size detector allocation");
    if (!detector) exit(2);
    for (size_t i = 0; i < sizeof(cases) / sizeof(cases[0]); ++i) {
        char label[100];
        snprintf(label, sizeof(label), "diameter %d thickness %.0f",
                 cases[i].diameter, cases[i].thickness);
        image_clear(&image);
        ring(&image, 137, 119, cases[i].diameter, cases[i].thickness, BLUE);
        SWSeat out[4];
        const int32_t actual = scan(detector, &image, 7, out, 4);
        CHECK(actual == 1, label);
        if (actual == 1) expect_seat(out[0], 137, 119, cases[i].diameter, 1, label);
    }
    SWSeat out[4];
    image_clear(&image);
    ring(&image, 137, 119, 101, 2, BLUE);
    CHECK(sw_detector_scan(detector, image.data, image.stride, 7, 9, 100, out, 4) == 0,
          "maximum diameter is respected");
    image_clear(&image);
    ring(&image, 137, 119, 21, 2, BLUE);
    CHECK(sw_detector_scan(detector, image.data, image.stride, 7, 22, 240, out, 4) == 0,
          "minimum diameter is respected");
    sw_detector_destroy(detector);
    free(image.data);
}

static void rejection_and_reuse_cases(void) {
    Image image = image_new(130, 110, 20);
    SWDetector *detector = sw_detector_create(image.width, image.height);
    CHECK(detector != NULL, "rejection detector allocation");
    if (!detector) exit(2);
    SWSeat out[8];
    image_clear(&image);
    CHECK(scan(detector, &image, 7, out, 8) == 0, "empty frame");
    ring(&image, 54, 44, 31, 2, GRAY);
    CHECK(scan(detector, &image, 7, out, 8) == 0, "unavailable gray ring");
    image_clear(&image);
    ring(&image, 54, 44, 31, 2, PALE);
    CHECK(scan(detector, &image, 7, out, 8) == 0, "pale ring");
    image_clear(&image);
    ring(&image, 54, 44, 31, 16, BLUE);
    CHECK(scan(detector, &image, 7, out, 8) == 0, "solid blue disk");
    image_clear(&image);
    square_border(&image, 54, 44, 41, 2, BLUE);
    CHECK(scan(detector, &image, 7, out, 8) == 0, "square outline");
    image_clear(&image);
    for (int32_t d = -16; d <= 16; ++d) {
        for (int32_t t = -1; t <= 1; ++t) {
            paint(&image, 54 + d, 44 + t, BLUE);
            paint(&image, 54 + t, 44 + d, BLUE);
        }
    }
    CHECK(scan(detector, &image, 7, out, 8) == 0, "colored plus-shaped text");
    image_clear(&image);
    ring(&image, 10, 44, 21, 2, BLUE);
    CHECK(scan(detector, &image, 7, out, 8) == 0, "ring touching left crop edge");
    image_clear(&image);
    ring(&image, 127, 44, 21, 2, BLUE);
    CHECK(scan(detector, &image, 7, out, 8) == 0, "partly clipped ring");
    image_clear(&image);
    for (int32_t y = 0; y < image.height; ++y)
        for (int32_t x = 0; x < image.width; ++x) paint(&image, x, y, BLUE);
    CHECK(scan(detector, &image, 7, out, 8) == 0, "large filled colored background");
    /* Reuse the same context after empty and oversize connected components. */
    for (int run = 0; run < 12; ++run) {
        image_clear(&image);
        const int32_t x = 24 + run * 4, y = 24 + run * 3;
        ring(&image, x, y, 21, 2, PURPLE);
        const int32_t actual = scan(detector, &image, 7, out, 8);
        CHECK(actual == 1, "scratch state is reset between frames");
        if (actual == 1) expect_seat(out[0], x, y, 21, 3, "reused context coordinates");
        image_clear(&image);
        CHECK(scan(detector, &image, 7, out, 8) == 0, "removed ring does not persist");
    }
    sw_detector_destroy(detector);
    free(image.data);
}

static void antialiased_subpixel_cases(void) {
    static const struct {
        double x, y, diameter_x, diameter_y, thickness;
        Color color;
        int32_t expected_kind;
        const char *label;
    } cases[] = {
        {64.5, 43.5, 20, 20, 2, {83, 176, 249}, 1, "AA blue 20px half-pixel circle"},
        {64.5, 43.5, 20, 20, 2, {121, 105, 230}, 3, "AA purple 20px half-pixel circle"},
        {104.5, 83.5, 100, 100, 2, {83, 176, 249}, 1, "AA blue 100px thin half-pixel circle"},
        {104.5, 83.5, 100, 100, 2, {121, 105, 230}, 3, "AA purple 100px thin half-pixel circle"},
        {164.5, 139.5, 110, 100, 3, {83, 176, 249}, 1, "AA mild ellipse 1.1 aspect"},
        {164.5, 139.5, 180, 100, 3, {121, 105, 230}, 0, "AA elongated ellipse rejected"}
    };
    Image image = image_new(320, 240, 12);
    SWDetector *detector = sw_detector_create(image.width, image.height);
    CHECK(detector != NULL, "antialiased detector allocation");
    if (!detector) exit(2);
    for (size_t i = 0; i < sizeof(cases) / sizeof(cases[0]); ++i) {
        image_clear(&image);
        supersampled_ring(&image, cases[i].x, cases[i].y,
                           cases[i].diameter_x, cases[i].diameter_y,
                           cases[i].thickness, cases[i].color);
        SWSeat out[4];
        const int32_t count = scan(detector, &image, 7, out, 4);
        CHECK(count == (cases[i].expected_kind ? 1 : 0), cases[i].label);
        if (count == 1 && cases[i].expected_kind) {
            CHECK(fabs(out[0].x - cases[i].x) <= 1.0, cases[i].label);
            CHECK(fabs(out[0].y - cases[i].y) <= 1.0, cases[i].label);
            CHECK(out[0].kind == cases[i].expected_kind, cases[i].label);
        }
    }
    sw_detector_destroy(detector);
    free(image.data);
}

static void capacity_and_validation_cases(void) {
    CHECK(sw_detector_create(0, 10) == NULL, "reject zero dimension");
    CHECK(sw_detector_create(-1, 10) == NULL, "reject negative dimension");
    CHECK(sw_detector_create(10, 2) == NULL, "reject unsupported tiny dimension");
    CHECK(sw_detector_create(32769, 10) == NULL, "reject oversized dimension");
    CHECK(sw_detector_create(32768, 32768) == NULL, "reject excessive area before allocation");
    sw_detector_destroy(NULL);
    Image image = image_new(90, 80, 8);
    image_clear(&image);
    ring(&image, 24, 20, 21, 2, BLUE);
    ring(&image, 62, 56, 21, 2, GREEN);
    SWDetector *detector = sw_detector_create(image.width, image.height);
    CHECK(detector != NULL, "validation detector allocation");
    if (!detector) exit(2);
    struct { SWSeat out[1]; uint32_t sentinel; } limited = {{{0, 0, 0, 0}}, 0x12345678u};
    CHECK(scan(detector, &image, 7, limited.out, 1) == -2, "capacity overflow is reported");
    CHECK(limited.sentinel == 0x12345678u, "capacity overflow does not overwrite caller memory");
    SWSeat out[4];
    const int32_t actual = scan(detector, &image, 7, out, 4);
    CHECK(actual == 2, "scan recovers after capacity error");
    if (actual == 2) {
        expect_seat(out[0], 24, 20, 21, 1, "top-left orientation upper seat");
        expect_seat(out[1], 62, 56, 21, 2, "top-left orientation lower seat");
    }
    CHECK(sw_detector_scan(NULL, image.data, image.stride, 7, 9, 240, out, 4) == -1,
          "null detector rejected");
    CHECK(sw_detector_scan(detector, NULL, image.stride, 7, 9, 240, out, 4) == -1,
          "null frame rejected");
    CHECK(sw_detector_scan(detector, image.data, image.stride, 7, 9, 240, NULL, 4) == -1,
          "null output rejected");
    CHECK(sw_detector_scan(detector, image.data, image.width * 4 - 1, 7, 9, 240, out, 4) == -1,
          "short row stride rejected");
    CHECK(sw_detector_scan(detector, image.data, -1, 7, 9, 240, out, 4) == -1,
          "negative row stride rejected");
    CHECK(sw_detector_scan(detector, image.data, image.stride, 8, 9, 240, out, 4) == -1,
          "unknown color flags rejected");
    CHECK(sw_detector_scan(detector, image.data, image.stride, 7, 4, 240, out, 4) == -1,
          "unsupported minimum rejected");
    CHECK(sw_detector_scan(detector, image.data, image.stride, 7, 30, 20, out, 4) == -1,
          "inverted diameter range rejected");
    CHECK(sw_detector_scan(detector, image.data, image.stride, 7, 9, 32769, out, 4) == -1,
          "oversized maximum rejected");
    CHECK(sw_detector_scan(detector, image.data, image.stride, 7, 9, 240, out, 0) == -1,
          "zero capacity rejected");
    CHECK(sw_detector_scan(detector, image.data, image.stride, 7, 9, 240, out, -1) == -1,
          "negative capacity rejected");
    sw_detector_destroy(detector);
    free(image.data);
}

int main(void) {
    color_cases();
    size_cases();
    rejection_and_reuse_cases();
    antialiased_subpixel_cases();
    capacity_and_validation_cases();
    printf("%s: %d detector assertions, %d failures\n",
           failures ? "FAIL" : "PASS", checks, failures);
    return failures ? 1 : 0;
}
