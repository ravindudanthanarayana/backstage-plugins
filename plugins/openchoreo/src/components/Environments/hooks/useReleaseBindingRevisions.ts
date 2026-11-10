import { useCallback, useEffect, useState } from 'react';
import { useApi } from '@backstage/core-plugin-api';
import { Entity, stringifyEntityRef } from '@backstage/catalog-model';
import { useOpenChoreoQuery } from '@openchoreo/backstage-plugin-react';
import type { BindingRevision } from '@openchoreo/backstage-plugin-common';
import { openChoreoClientApiRef } from '../../../api/OpenChoreoClientApi';
import {
  type BindingKind,
  hasProgressing,
  sortNewestFirst,
} from '../utils/revisionUtils';

/**
 * Whether the controller has recorded the named revision as the active one.
 * Existing is not enough: its status is written separately, after creation.
 */
const isRecorded = (
  revisions: BindingRevision[] | undefined,
  name: string,
): boolean =>
  !!revisions?.some(r => r.metadata.name === name && r.status?.active === true);

/** How often the list refreshes while a revision is still settling. */
export const REVISION_POLL_INTERVAL_MS = 5000;
/**
 * How long to keep polling for the revision a rollback is recorded as. The
 * controller records it on its next reconcile, normally within seconds.
 */
export const AWAIT_REVISION_TIMEOUT_MS = 60_000;

export interface UseReleaseBindingRevisionsOptions {
  /**
   * Which binding the entity owns: a Component's ReleaseBinding (default)
   * or a Resource's ResourceReleaseBinding.
   */
  kind?: BindingKind;
  pollIntervalMs?: number;
  awaitTimeoutMs?: number;
}

export interface UseReleaseBindingRevisionsResult {
  /** Revisions of the binding, newest first. */
  revisions: BindingRevision[];
  loading: boolean;
  isRefetching: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
  /**
   * Keep refreshing until a revision with this name appears as the active
   * one. Rollbacks are recorded by the controller after the API call
   * returns, so the new revision is not in the list straight away.
   */
  awaitRevision: (revisionName: string) => void;
}

/**
 * Fetches the revision history of the entity's binding in one environment:
 * a Component's ReleaseBinding, or a Resource's ResourceReleaseBinding.
 * bindingName narrows it to that binding, since a component has one binding
 * per release line in an environment. The list refreshes on an interval while any revision is
 * Progressing, and while a revision passed to awaitRevision is missing.
 */
export function useReleaseBindingRevisions(
  entity: Entity,
  environment: string | undefined,
  bindingName: string | undefined,
  {
    kind = 'component',
    pollIntervalMs = REVISION_POLL_INTERVAL_MS,
    awaitTimeoutMs = AWAIT_REVISION_TIMEOUT_MS,
  }: UseReleaseBindingRevisionsOptions = {},
): UseReleaseBindingRevisionsResult {
  const client = useApi(openChoreoClientApiRef);
  const [awaiting, setAwaiting] = useState<string | null>(null);

  const { data, loading, isRefetching, error, refetch } = useOpenChoreoQuery(
    [
      kind === 'resource'
        ? 'resourceReleaseBindingRevisions'
        : 'releaseBindingRevisions',
      stringifyEntityRef(entity),
      environment ?? '',
      bindingName ?? '',
    ],
    async () =>
      sortNewestFirst(
        kind === 'resource'
          ? await client.listResourceReleaseBindingRevisions(
              entity,
              environment!,
              bindingName,
            )
          : await client.listReleaseBindingRevisions(
              entity,
              environment!,
              bindingName,
            ),
      ),
    {
      enabled: !!environment,
      refetchInterval: query => {
        const revisions = query.state.data;
        const missing = awaiting !== null && !isRecorded(revisions, awaiting);
        return missing || hasProgressing(revisions) ? pollIntervalMs : false;
      },
    },
  );

  // Stop waiting once the revision shows up, or after the timeout so a
  // rollback the controller never records doesn't poll forever.
  useEffect(() => {
    if (awaiting === null) return undefined;
    if (isRecorded(data, awaiting)) {
      setAwaiting(null);
      return undefined;
    }
    const timer = setTimeout(() => setAwaiting(null), awaitTimeoutMs);
    return () => clearTimeout(timer);
  }, [awaiting, data, awaitTimeoutMs]);

  // A different environment has its own history; drop a pending wait.
  useEffect(() => {
    setAwaiting(null);
  }, [environment]);

  const awaitRevision = useCallback(
    (revisionName: string) => {
      setAwaiting(revisionName);
      refetch();
    },
    [refetch],
  );

  return {
    revisions: data ?? [],
    loading,
    isRefetching,
    error,
    refetch,
    awaitRevision,
  };
}
