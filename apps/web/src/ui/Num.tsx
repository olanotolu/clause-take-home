import NumberFlow, { type NumberFlowProps } from "@number-flow/react";

/**
 * Every animated number in the app. NumberFlow's own defaults take ~900 ms, which makes a counter feel like it is lagging
 * behind the thing it counts; UI motion should finish in a quarter of a second. Digits roll on a strong ease-out, and
 * `prefers-reduced-motion` is honoured by the library itself.
 */
const TIMING = { duration: 280, easing: "cubic-bezier(0.23, 1, 0.32, 1)" } as const;

export function Num(props: NumberFlowProps) {
  return <NumberFlow transformTiming={TIMING} spinTiming={TIMING} opacityTiming={{ duration: 160, easing: "ease-out" }} {...props} />;
}
