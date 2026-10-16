/*
 * Adapted from Motion Primitives (https://motion-primitives.com), MIT License, Copyright (c) 2024 ibelick.
 * Changes: our `cn` helper, no "use client" directive (this is a Vite app), and `defaultValue` also follows later changes
 * so a controlled parent stays in sync.
 */
import { AnimatePresence, motion, type Transition } from "motion/react";
import { Children, cloneElement, useEffect, useId, useState, type ReactElement } from "react";
import { cn } from "../../lib/cn.ts";

export type AnimatedBackgroundProps = {
  children: ReactElement<{ "data-id": string }>[] | ReactElement<{ "data-id": string }>;
  defaultValue?: string;
  onValueChange?: (newActiveId: string | null) => void;
  className?: string;
  transition?: Transition;
  enableHover?: boolean;
};

export function AnimatedBackground({ children, defaultValue, onValueChange, className, transition, enableHover = false }: AnimatedBackgroundProps) {
  const [activeId, setActiveId] = useState<string | null>(defaultValue ?? null);
  const uniqueId = useId();

  const handleSetActiveId = (id: string | null) => {
    setActiveId(id);
    onValueChange?.(id);
  };

  useEffect(() => {
    if (defaultValue !== undefined) setActiveId(defaultValue);
  }, [defaultValue]);

  return Children.map(children, (child: ReactElement<{ "data-id": string; className?: string; children?: React.ReactNode }>, index) => {
    const id = child.props["data-id"];
    const interactionProps = enableHover ? { onMouseEnter: () => handleSetActiveId(id), onMouseLeave: () => handleSetActiveId(null) } : { onClick: () => handleSetActiveId(id) };

    return cloneElement(
      child,
      { key: index, className: cn("relative inline-flex", child.props.className), "data-checked": activeId === id ? "true" : "false", ...interactionProps } as object,
      <>
        <AnimatePresence initial={false}>
          {activeId === id && (
            <motion.div
              layoutId={`background-${uniqueId}`}
              className={cn("absolute inset-0", className)}
              {...(transition && { transition })}
              initial={{ opacity: defaultValue ? 1 : 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
            />
          )}
        </AnimatePresence>
        <div className="z-10 inline-flex items-center gap-1.5">{child.props.children}</div>
      </>,
    );
  });
}
