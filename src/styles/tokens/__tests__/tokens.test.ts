import { animation, colors, radius, shadows, spacing, typography, zIndex } from '../index';

describe('design tokens', () => {
  it('exports a dark-first neon color palette', () => {
    expect(colors.dark.background.primary).toBe('#050509');
    expect(colors.dark.accent.electricBlue).toBe('#33A3FF');
    expect(colors.dark.accent.neonGreen).toBe('#39FF88');
    expect(colors.light).toBeDefined();
  });

  it('exports scalable visual primitives', () => {
    expect(spacing[6]).toBe(24);
    expect(radius.lg).toBe(18);
    expect(typography.size.body).toBe(16);
    expect(shadows.neonBlue.shadowColor).toBe(colors.dark.accent.electricBlue);
    expect(zIndex.modal).toBeGreaterThan(zIndex.header);
    expect(animation.duration.normal).toBe(220);
  });
});
