export type CompletionSwipeAction = "accept" | "dismiss" | null;
export type CompletionTouchIntent =
  | "pending"
  | "horizontal"
  | "vertical";

export interface RectangleBounds {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export const COMPLETION_SWIPE_HIT_PADDING_PX = 18;
export const COMPLETION_SWIPE_MIN_DISTANCE_PX = 48;
const COMPLETION_SWIPE_HORIZONTAL_DOMINANCE = 1.25;
export const COMPLETION_TOUCH_INTENT_DISTANCE_PX = 12;

export function pointNearRectangle(
  x: number,
  y: number,
  rectangle: RectangleBounds,
  padding = COMPLETION_SWIPE_HIT_PADDING_PX,
): boolean {
  return (
    x >= rectangle.left - padding &&
    x <= rectangle.right + padding &&
    y >= rectangle.top - padding &&
    y <= rectangle.bottom + padding
  );
}

export function completionSwipeAction(
  deltaX: number,
  deltaY: number,
  minimumDistance = COMPLETION_SWIPE_MIN_DISTANCE_PX,
): CompletionSwipeAction {
  const horizontalDistance = Math.abs(deltaX);
  const verticalDistance = Math.abs(deltaY);
  if (
    horizontalDistance < minimumDistance ||
    horizontalDistance <
      verticalDistance * COMPLETION_SWIPE_HORIZONTAL_DOMINANCE
  ) {
    return null;
  }
  return deltaX > 0 ? "accept" : "dismiss";
}

export function completionTouchIntent(
  deltaX: number,
  deltaY: number,
  intentDistance = COMPLETION_TOUCH_INTENT_DISTANCE_PX,
): CompletionTouchIntent {
  const horizontalDistance = Math.abs(deltaX);
  const verticalDistance = Math.abs(deltaY);
  if (
    verticalDistance >= intentDistance &&
    verticalDistance > horizontalDistance
  ) {
    return "vertical";
  }
  if (
    horizontalDistance >= intentDistance &&
    horizontalDistance >
      verticalDistance * COMPLETION_SWIPE_HORIZONTAL_DOMINANCE
  ) {
    return "horizontal";
  }
  return "pending";
}
