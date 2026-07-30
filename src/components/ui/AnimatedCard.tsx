import React, { useState, useEffect } from 'react';
import { StyleSheet, Animated } from 'react-native';

interface AnimatedCardProps {
  children: React.ReactNode;
  delay?: number;
}

export function AnimatedCard({ children, delay = 0 }: AnimatedCardProps) {
  const [animatedValue] = useState(() => new Animated.Value(0));

  useEffect(() => {
    Animated.timing(animatedValue, {
      toValue: 1,
      duration: 300,
      delay,
      useNativeDriver: true,
    }).start();
  }, [animatedValue, delay]);

  return (
    <Animated.View
      style={[
        styles.card,
        {
          opacity: animatedValue,
          transform: [
            {
              translateY: animatedValue.interpolate({
                inputRange: [0, 1],
                outputRange: [20, 0],
              }),
            },
          ],
        },
      ]}
    >
      {children}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: '#0A0A0F',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#1C1C1E',
  },
});
