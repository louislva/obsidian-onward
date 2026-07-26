import { describe, expect, it } from "vitest";
import {
  completionSwipeAction,
  pointNearRectangle,
  shouldYieldToVerticalScroll,
} from "./touch-gesture";

describe("completion touch gestures", () => {
  it("accepts a deliberate right swipe and dismisses a left swipe", () => {
    expect(completionSwipeAction(60, 8)).toBe("accept");
    expect(completionSwipeAction(-60, -8)).toBe("dismiss");
  });

  it("ignores taps, short drags, and vertically dominant movement", () => {
    expect(completionSwipeAction(0, 0)).toBeNull();
    expect(completionSwipeAction(40, 2)).toBeNull();
    expect(completionSwipeAction(55, 50)).toBeNull();
    expect(completionSwipeAction(20, 80)).toBeNull();
    expect(shouldYieldToVerticalScroll(4, 20)).toBe(true);
    expect(shouldYieldToVerticalScroll(20, 4)).toBe(false);
    expect(shouldYieldToVerticalScroll(2, 8)).toBe(false);
  });

  it("limits gesture starts to the padded suggestion area", () => {
    const suggestion = {
      left: 100,
      right: 180,
      top: 200,
      bottom: 220,
    };

    expect(pointNearRectangle(110, 210, suggestion)).toBe(true);
    expect(pointNearRectangle(84, 210, suggestion)).toBe(true);
    expect(pointNearRectangle(80, 210, suggestion)).toBe(false);
    expect(pointNearRectangle(110, 240, suggestion)).toBe(false);
  });
});
