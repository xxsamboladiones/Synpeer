import { Text, View } from 'react-native';

export function BootstrapScreen() {
  return (
    <View className="flex-1 items-center justify-center bg-black px-6">
      <Text className="text-3xl font-semibold text-white">Insta99</Text>
      <Text className="mt-3 text-center text-base text-zinc-400">
        Fundação descentralizada em construção.
      </Text>
    </View>
  );
}
