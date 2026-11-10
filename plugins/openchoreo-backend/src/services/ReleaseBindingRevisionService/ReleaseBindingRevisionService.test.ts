import { mockServices } from '@backstage/backend-test-utils';
import { ConflictError, NotAllowedError } from '@backstage/errors';
import { createOkResponse, createErrorResponse } from '@openchoreo/test-utils';
import { ReleaseBindingRevisionService } from './ReleaseBindingRevisionService';

const mockGET = jest.fn();
const mockPOST = jest.fn();
const mockDELETE = jest.fn();

jest.mock('@openchoreo/openchoreo-client-node', () => ({
  ...jest.requireActual('@openchoreo/openchoreo-client-node'),
  createOpenChoreoApiClient: jest.fn(() => ({
    GET: mockGET,
    POST: mockPOST,
    DELETE: mockDELETE,
  })),
}));

const mockLogger = mockServices.logger.mock();

function createService() {
  return new ReleaseBindingRevisionService(mockLogger, 'http://test:8080');
}

const revision = (n: number) => ({
  metadata: { name: `api-dev-r${n}`, namespace: 'test-ns' },
  spec: { revision: n, cause: 'Deploy', componentReleaseName: `api-${n}` },
  status: { health: 'Healthy', active: false, knownGood: true },
});

const listRequest = {
  namespaceName: 'test-ns',
  componentName: 'api',
  environment: 'development',
};

const conflict = (code: string, message: string) => ({
  data: undefined,
  error: { error: message, code },
  response: { ok: false as const, status: 409, statusText: 'Conflict' },
});

describe('ReleaseBindingRevisionService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('listRevisions', () => {
    it('queries by component and environment', async () => {
      mockGET.mockResolvedValueOnce(
        createOkResponse({ items: [revision(1)], pagination: {} }),
      );

      const result = await createService().listRevisions(listRequest, 'tok');

      expect(result).toEqual([revision(1)]);
      expect(mockGET).toHaveBeenCalledWith(
        '/api/v1/namespaces/{namespaceName}/releasebindingrevisions',
        {
          params: {
            path: { namespaceName: 'test-ns' },
            query: {
              component: 'api',
              environment: 'development',
              limit: 100,
            },
          },
        },
      );
    });

    it('narrows to one binding when a binding name is given', async () => {
      mockGET.mockResolvedValueOnce(
        createOkResponse({ items: [revision(1)], pagination: {} }),
      );

      await createService().listRevisions(
        { ...listRequest, bindingName: 'api-next-development' },
        'tok',
      );

      expect(mockGET).toHaveBeenCalledWith(
        '/api/v1/namespaces/{namespaceName}/releasebindingrevisions',
        {
          params: {
            path: { namespaceName: 'test-ns' },
            query: {
              component: 'api',
              environment: 'development',
              binding: 'api-next-development',
              limit: 100,
            },
          },
        },
      );
    });

    it('follows the cursor across pages', async () => {
      mockGET
        .mockResolvedValueOnce(
          createOkResponse({
            items: [revision(3), revision(2)],
            pagination: { nextCursor: 'c1' },
          }),
        )
        .mockResolvedValueOnce(
          createOkResponse({ items: [revision(1)], pagination: {} }),
        );

      const result = await createService().listRevisions(listRequest);

      expect(result.map(r => r.spec.revision)).toEqual([3, 2, 1]);
      expect(mockGET).toHaveBeenCalledTimes(2);
      expect(mockGET.mock.calls[1][1].params.query.cursor).toBe('c1');
    });

    it('maps 403 to NotAllowedError', async () => {
      mockGET.mockResolvedValueOnce(createErrorResponse(403, 'denied'));

      await expect(
        createService().listRevisions(listRequest),
      ).rejects.toBeInstanceOf(NotAllowedError);
    });
  });

  describe('rollback', () => {
    const rollbackRequest = {
      namespaceName: 'test-ns',
      bindingName: 'api-dev',
      revision: 2,
      dryRun: true,
    };

    it('posts the revision and dryRun flag', async () => {
      const preview = {
        revisionName: 'api-dev-r4',
        revision: 4,
        targetRevision: 2,
        dryRun: true,
        changes: [],
        warnings: [],
      };
      mockPOST.mockResolvedValueOnce(createOkResponse(preview));

      const result = await createService().rollback(rollbackRequest, 'tok');

      expect(result).toEqual(preview);
      expect(mockPOST).toHaveBeenCalledWith(
        '/api/v1/namespaces/{namespaceName}/releasebindings/{releaseBindingName}/rollback',
        {
          params: {
            path: { namespaceName: 'test-ns', releaseBindingName: 'api-dev' },
          },
          body: { revision: 2, dryRun: true },
        },
      );
    });

    it('sends a message only when one is given', async () => {
      mockPOST.mockResolvedValueOnce(createOkResponse({}));
      await createService().rollback(
        { ...rollbackRequest, dryRun: false, message: 'Payments failing' },
        'tok',
      );
      expect(mockPOST).toHaveBeenLastCalledWith(
        expect.any(String),
        expect.objectContaining({
          body: { revision: 2, dryRun: false, message: 'Payments failing' },
        }),
      );
    });

    it.each(['RELEASE_DELETED', 'CONCURRENT_MODIFICATION'])(
      'keeps the %s code on a 409',
      async code => {
        mockPOST.mockResolvedValueOnce(conflict(code, 'conflict detail'));

        const err = await createService()
          .rollback(rollbackRequest)
          .catch(e => e);

        expect(err).toBeInstanceOf(ConflictError);
        expect(err.message).toBe('conflict detail');
        expect(err.code).toBe(code);
      },
    );

    it('maps 403 to NotAllowedError', async () => {
      mockPOST.mockResolvedValueOnce(createErrorResponse(403, 'denied'));

      await expect(
        createService().rollback(rollbackRequest),
      ).rejects.toBeInstanceOf(NotAllowedError);
    });
  });

  describe('listResourceRevisions', () => {
    const resourceRevision = (n: number) => ({
      metadata: { name: `db-dev-r${n}`, namespace: 'test-ns' },
      spec: { revision: n, cause: 'Deploy', resourceReleaseName: `db-${n}` },
      status: { health: 'Healthy', active: false },
    });
    const resourceListRequest = {
      namespaceName: 'test-ns',
      resourceName: 'db',
      environment: 'development',
    };

    it('queries by resource and environment, following the cursor', async () => {
      mockGET
        .mockResolvedValueOnce(
          createOkResponse({
            items: [resourceRevision(2)],
            pagination: { nextCursor: 'c1' },
          }),
        )
        .mockResolvedValueOnce(
          createOkResponse({ items: [resourceRevision(1)], pagination: {} }),
        );

      const result = await createService().listResourceRevisions(
        resourceListRequest,
        'tok',
      );

      expect(result).toEqual([resourceRevision(2), resourceRevision(1)]);
      expect(mockGET).toHaveBeenNthCalledWith(
        1,
        '/api/v1/namespaces/{namespaceName}/resourcereleasebindingrevisions',
        {
          params: {
            path: { namespaceName: 'test-ns' },
            query: { resource: 'db', environment: 'development', limit: 100 },
          },
        },
      );
      expect(mockGET.mock.calls[1][1].params.query.cursor).toBe('c1');
    });

    it('maps 403 to NotAllowedError', async () => {
      mockGET.mockResolvedValueOnce(createErrorResponse(403, 'denied'));

      await expect(
        createService().listResourceRevisions(resourceListRequest),
      ).rejects.toBeInstanceOf(NotAllowedError);
    });
  });

  describe('rollbackResource', () => {
    const resourceRollbackRequest = {
      namespaceName: 'test-ns',
      bindingName: 'db-dev',
      revision: 1,
      dryRun: false,
    };

    it('posts to the resource binding rollback endpoint', async () => {
      const applied = {
        revisionName: 'db-dev-r1',
        revisionDisplayName: 'db-1-r1',
        revision: 1,
        targetRevision: 1,
        dryRun: false,
        changes: [],
        warnings: [],
      };
      mockPOST.mockResolvedValueOnce(createOkResponse(applied));

      const result = await createService().rollbackResource(
        resourceRollbackRequest,
        'tok',
      );

      expect(result).toEqual(applied);
      expect(mockPOST).toHaveBeenCalledWith(
        '/api/v1/namespaces/{namespaceName}/resourcereleasebindings/{resourceReleaseBindingName}/rollback',
        {
          params: {
            path: {
              namespaceName: 'test-ns',
              resourceReleaseBindingName: 'db-dev',
            },
          },
          body: { revision: 1, dryRun: false },
        },
      );
    });

    it.each(['RELEASE_DELETED', 'CONCURRENT_MODIFICATION'])(
      'keeps the %s code on a 409',
      async code => {
        mockPOST.mockResolvedValueOnce(conflict(code, 'conflict detail'));

        const err = await createService()
          .rollbackResource(resourceRollbackRequest)
          .catch(e => e);

        expect(err).toBeInstanceOf(ConflictError);
        expect(err.code).toBe(code);
      },
    );
  });

  describe('deleteRevision / deleteResourceRevision', () => {
    const request = {
      namespaceName: 'test-ns',
      bindingName: 'api-dev',
      revisionName: 'api-dev-r2',
      dryRun: true,
    };

    it.each([
      [
        'deleteRevision',
        '/api/v1/namespaces/{namespaceName}/releasebindingrevisions/{releaseBindingRevisionName}',
        'releaseBindingRevisionName',
      ],
      [
        'deleteResourceRevision',
        '/api/v1/namespaces/{namespaceName}/resourcereleasebindingrevisions/{resourceReleaseBindingRevisionName}',
        'resourceReleaseBindingRevisionName',
      ],
    ] as const)(
      '%s calls DELETE with binding and dryRun',
      async (method, path, param) => {
        const result = {
          revisionName: 'api-dev-r2',
          revision: 2,
          dryRun: true,
        };
        mockDELETE.mockResolvedValueOnce(createOkResponse(result));

        await expect(createService()[method](request, 'tok')).resolves.toEqual(
          result,
        );
        expect(mockDELETE).toHaveBeenCalledWith(path, {
          params: {
            path: { namespaceName: 'test-ns', [param]: 'api-dev-r2' },
            query: { binding: 'api-dev', dryRun: true },
          },
        });
      },
    );

    it('keeps the code of a 409', async () => {
      mockDELETE.mockResolvedValueOnce(
        conflict(
          'REVISION_PROTECTED',
          'Cannot delete revision 2 because it is currently active',
        ),
      );

      const err = await createService()
        .deleteRevision(request, 'tok')
        .catch(e => e);
      expect(err).toBeInstanceOf(ConflictError);
      expect(err.message).toBe(
        'Cannot delete revision 2 because it is currently active',
      );
      expect(err.code).toBe('REVISION_PROTECTED');
    });

    it('maps 403 to NotAllowedError', async () => {
      mockDELETE.mockResolvedValueOnce(createErrorResponse(403));
      await expect(
        createService().deleteResourceRevision(request, 'tok'),
      ).rejects.toThrow(NotAllowedError);
    });
  });
});
