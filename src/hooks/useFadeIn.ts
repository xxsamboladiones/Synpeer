import { useEffect, useState } from 'react';
import { Animated, Easing } from 'react-native';

import { animation } from '@/styles/tokens';
import { supportsNativeAnimatedDriver } from '@/utils/animationDriver';

export function useFadeIn() {
  const [opacity] = useState(() => new Animated.Value(0));
  const [translateY] = useState(() => new Animated.Value(8));

  useEffect(() => {
    Animated.parallel([
      Animated.timing(opacity, {
        toValue: 1,
        duration: animation.duration.normal,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: supportsNativeAnimatedDriver,
      }),
      Animated.timing(translateY, {
        toValue: 0,
        duration: animation.duration.normal,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: supportsNativeAnimatedDriver,
      }),
    ]).start();
  }, [opacity, translateY]);

  return {
    opacity,
    transform: [{ translateY }],
  };
}
