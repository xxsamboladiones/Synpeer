import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Avatar, Button, Card, Header, Input, Screen, Text } from '@/components/ui';
import { createLogger } from '@/observability/Logger';
import { appService } from '@/services/AppService';
import { useAuthStore } from '@/store/authStore';

type CreateIdentityScreenProps = {
  onContinue: () => void;
};

const logger = createLogger('CreateIdentityScreen');

export function CreateIdentityScreen({ onContinue }: CreateIdentityScreenProps) {
  const [displayName, setDisplayName] = useState('');
  const [publicIdentity, setPublicIdentity] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const setIdentityCreated = useAuthStore((state) => state.setIdentityCreated);

  const handleCreateIdentity = async () => {
    if (!displayName.trim()) {
      setError('Por favor, insira um nome publico');
      return;
    }

    setIsCreating(true);
    setError(null);

    try {
      await appService.initialize();
      const identity = await appService.createLocalIdentity();
      await appService.getSocialApplicationService().updateLocalProfile({
        displayName: displayName.trim(),
      });

      setPublicIdentity(identity);
      setIdentityCreated?.(true);
      onContinue();
    } catch (err) {
      logger.error('identity_creation_failed', err);
      setError(getIdentityCreationMessage(err));
    } finally {
      setIsCreating(false);
    }
  };

  const canContinue = displayName.trim().length > 0 && !isCreating && !publicIdentity;

  return (
    <Screen>
      <View style={styles.content}>
        <Header title="Criar identidade" subtitle="Gere sua identidade criptografica unica" />
        <Card>
          <View style={styles.avatarRow}>
            <Avatar label={displayName || 'Synpeer'} size={72} />
            <View style={styles.avatarCopy}>
              <Text variant="title">Perfil local</Text>
              <Text variant="bodySmall" tone="muted">
                Sua identidade sera gerada automaticamente
              </Text>
            </View>
          </View>
          <Input
            label="Nome publico"
            placeholder="Seu nome publico"
            value={displayName}
            onChangeText={setDisplayName}
            editable={!isCreating && !publicIdentity}
          />

          {publicIdentity && (
            <View style={styles.identitySection}>
              <Text variant="bodySmall" tone="muted">
                Identidade publica gerada:
              </Text>
              <Text variant="bodySmall" style={styles.identityText}>
                {publicIdentity.slice(0, 16)}...{publicIdentity.slice(-16)}
              </Text>
              <Text variant="bodySmall" tone="muted" style={styles.successText}>
                Identidade criada com sucesso!
              </Text>
            </View>
          )}

          {error && (
            <Text variant="bodySmall" style={styles.errorText}>
              {error}
            </Text>
          )}

          <Button
            label={
              isCreating
                ? 'Gerando identidade...'
                : publicIdentity
                  ? 'Continuando...'
                  : 'Criar identidade'
            }
            onPress={handleCreateIdentity}
            disabled={!canContinue}
          />
        </Card>
      </View>
    </Screen>
  );
}

function getIdentityCreationMessage(error: unknown): string {
  if (error instanceof Error && error.message === 'Profile already exists') {
    return 'Essa identidade ja possui um perfil local. Continue para o feed ou edite o perfil.';
  }
  return 'Erro ao criar identidade. Tente novamente.';
}

const styles = StyleSheet.create({
  avatarCopy: {
    flex: 1,
    gap: 4,
  },
  avatarRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 16,
  },
  content: {
    flex: 1,
    gap: 24,
  },
  identitySection: {
    gap: 8,
    marginTop: 16,
  },
  identityText: {
    fontFamily: 'monospace',
    fontSize: 12,
  },
  successText: {
    color: '#4ade80',
  },
  errorText: {
    color: '#f87171',
    marginTop: 8,
  },
});
