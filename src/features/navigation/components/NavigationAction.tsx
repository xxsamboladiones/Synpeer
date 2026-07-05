import { Button } from '@/components/ui';

type NavigationActionProps = {
  label: string;
  onPress: () => void;
  variant?: 'primary' | 'secondary' | 'ghost';
};

export function NavigationAction({ label, onPress, variant = 'primary' }: NavigationActionProps) {
  return <Button fullWidth label={label} onPress={onPress} variant={variant} />;
}
