import React, { useState, useEffect } from 'react';
import { Text, TextStyle } from 'react-native';

interface AnimatedCounterProps {
  value: number;
  duration?: number;
  suffix?: string;
  style?: TextStyle;
}

export function AnimatedCounter({
  value,
  duration = 1000,
  suffix = '',
  style,
}: AnimatedCounterProps) {
  const [displayValue, setDisplayValue] = useState(0);

  useEffect(() => {
    let startTime: number;
    let timeoutId: ReturnType<typeof setTimeout>;

    const animate = () => {
      startTime = Date.now();
      const update = () => {
        const elapsed = Date.now() - startTime;
        const progress = Math.min(elapsed / duration, 1);

        // Easing function (ease-out)
        const easedProgress = 1 - Math.pow(1 - progress, 3);

        const currentValue = Math.floor(easedProgress * value);
        setDisplayValue(currentValue);

        if (progress < 1) {
          timeoutId = setTimeout(update, 16);
        }
      };

      update();
    };

    animate();

    return () => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    };
  }, [value, duration]);

  return (
    <Text style={style}>
      {displayValue.toLocaleString()}
      {suffix}
    </Text>
  );
}
