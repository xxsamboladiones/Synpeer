import React, { useState, useEffect } from 'react';
import { View, StyleSheet, Animated } from 'react-native';

interface AnimatedProgressProps {
  progress: number;
  height?: number;
  color?: string;
  backgroundColor?: string;
  borderRadius?: number;
}

export function AnimatedProgress({
  progress,
  height = 8,
  color = '#007AFF',
  backgroundColor = '#1C1C1E',
  borderRadius = 4,
}: AnimatedProgressProps) {
  const [animatedValue] = useState(new Animated.Value(0));

  useEffect(() => {
    Animated.timing(animatedValue, {
      toValue: progress,
      duration: 500,
      useNativeDriver: false,
    }).start();
  }, [progress, animatedValue]);

  return (
    <View style={[styles.container, { height, backgroundColor, borderRadius }]}>
      <Animated.View
        style={[
          styles.progress,
          {
            width: animatedValue.interpolate({
              inputRange: [0, 100],
              outputRange: ['0%', '100%'],
            }),
            backgroundColor: color,
            borderRadius,
          },
        ]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    overflow: 'hidden',
  },
  progress: {
    height: '100%',
  },
});
