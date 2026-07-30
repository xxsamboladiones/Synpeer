import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { createLogger } from '@/observability/Logger';
import { appService } from '@/services/AppService';
import type {
  ApplicationConnectivitySnapshot,
  ApplicationEvent,
  ApplicationEventTopic,
} from '@/services/events/ApplicationEventService';

const logger = createLogger('useApplicationEvents');

export interface ApplicationEventSubscriptionOptions {
  coalesceMs?: number;
}

export function useApplicationEvents(
  topics: readonly ApplicationEventTopic[],
  handler: (event: ApplicationEvent) => void | Promise<void>,
  options: ApplicationEventSubscriptionOptions = {},
): void {
  const topicKey = useMemo(() => Array.from(new Set(topics)).sort().join('|'), [topics]);
  const handlerRef = useRef(handler);
  const coalesceMs = options.coalesceMs ?? 50;

  useEffect(() => {
    handlerRef.current = handler;
  }, [handler]);

  useEffect(() => {
    let disposed = false;
    let unsubscribe: (() => void) | null = null;
    let timeout: ReturnType<typeof globalThis.setTimeout> | null = null;
    let pendingEvent: ApplicationEvent | null = null;
    const stableTopics = topicKey.split('|').filter(isApplicationEventTopic);

    const dispatch = (event: ApplicationEvent) => {
      if (disposed) {
        return;
      }
      pendingEvent = event;
      if (timeout) {
        globalThis.clearTimeout(timeout);
      }
      timeout = globalThis.setTimeout(() => {
        timeout = null;
        const nextEvent = pendingEvent;
        pendingEvent = null;
        if (!disposed && nextEvent) {
          Promise.resolve(handlerRef.current(nextEvent)).catch((error: unknown) => {
            logger.error('handler_failed', error, { eventType: nextEvent.type });
          });
        }
      }, coalesceMs);
    };

    void appService
      .initialize()
      .then(() => {
        if (!disposed) {
          unsubscribe = appService.subscribeApplicationEvents(stableTopics, dispatch);
        }
      })
      .catch((error: unknown) => {
        logger.warn('subscription_unavailable', {
          message: error instanceof Error ? error.message : 'Unknown initialization error',
        });
      });

    return () => {
      disposed = true;
      if (timeout) {
        globalThis.clearTimeout(timeout);
      }
      unsubscribe?.();
    };
  }, [coalesceMs, topicKey]);
}

export function useConnectivitySnapshot(): ApplicationConnectivitySnapshot {
  const [snapshot, setSnapshot] = useState<ApplicationConnectivitySnapshot>(
    createOfflineConnectivitySnapshot,
  );
  const refresh = useCallback(() => {
    setSnapshot(appService.getConnectivitySnapshot());
  }, []);

  useEffect(() => {
    let disposed = false;
    void appService
      .initialize()
      .then(() => {
        if (!disposed) {
          refresh();
        }
      })
      .catch(() => {
        if (!disposed) {
          setSnapshot(createOfflineConnectivitySnapshot());
        }
      });
    return () => {
      disposed = true;
    };
  }, [refresh]);

  useApplicationEvents(['peers'], refresh, { coalesceMs: 25 });
  return snapshot;
}

function createOfflineConnectivitySnapshot(): ApplicationConnectivitySnapshot {
  return {
    status: 'offline',
    connectedPeers: 0,
    syncingPeers: 0,
    reconnectingPeers: 0,
  };
}

function isApplicationEventTopic(value: string): value is ApplicationEventTopic {
  return (
    value === 'feed' ||
    value === 'chat' ||
    value === 'notifications' ||
    value === 'profile' ||
    value === 'peers' ||
    value === 'discover'
  );
}
