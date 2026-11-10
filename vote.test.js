/**
 * Unit tests for backend/functions/vote/index.js
 *
 * Mocks @aws-sdk DynamoDB clients so these run with no AWS credentials
 * and no network calls.
 *
 *   cd backend && npm install --save-dev jest aws-sdk-client-mock
 *   npx jest
 */

const { mockClient } = require('aws-sdk-client-mock');
const { DynamoDBDocumentClient, GetCommand, TransactWriteCommand } = require('@aws-sdk/lib-dynamodb');

process.env.VOTES_TABLE = 'Votes-test';
process.env.CANDIDATES_TABLE = 'Candidates-test';
process.env.ELECTION_CONFIG_TABLE = 'ElectionConfig-test';

const ddbMock = mockClient(DynamoDBDocumentClient);

const { handler } = require('../functions/vote/index');

function makeEvent({ voterId = 'voter-123', body = {} } = {}) {
  return {
    requestContext: { authorizer: { claims: { sub: voterId } } },
    body: JSON.stringify(body),
  };
}

beforeEach(() => {
  ddbMock.reset();
});

describe('CastVote handler', () => {
  test('rejects unauthenticated requests', async () => {
    const res = await handler({ requestContext: {}, body: '{}' });
    expect(res.statusCode).toBe(401);
  });

  test('rejects missing electionId/candidateId', async () => {
    const res = await handler(makeEvent({ body: {} }));
    expect(res.statusCode).toBe(400);
  });

  test('returns 404 when election does not exist', async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });

    const res = await handler(makeEvent({ body: { electionId: 'e1', candidateId: 'c1' } }));
    expect(res.statusCode).toBe(404);
  });

  test('returns 403 when election is not open', async () => {
    ddbMock.on(GetCommand).resolves({
      Item: {
        electionId: 'e1',
        status: 'CLOSED',
        startTime: '2020-01-01T00:00:00Z',
        endTime: '2020-01-02T00:00:00Z',
      },
    });

    const res = await handler(makeEvent({ body: { electionId: 'e1', candidateId: 'c1' } }));
    expect(res.statusCode).toBe(403);
  });

  test('casts a vote successfully when election is open and candidate exists', async () => {
    const now = new Date();
    const startTime = new Date(now.getTime() - 1000 * 60 * 60).toISOString();
    const endTime = new Date(now.getTime() + 1000 * 60 * 60).toISOString();

    ddbMock
      .on(GetCommand)
      .resolvesOnce({ Item: { electionId: 'e1', status: 'OPEN', startTime, endTime } }) // election lookup
      .resolvesOnce({ Item: { electionId: 'e1', candidateId: 'c1', name: 'Candidate One' } }); // candidate lookup

    ddbMock.on(TransactWriteCommand).resolves({});

    const res = await handler(makeEvent({ body: { electionId: 'e1', candidateId: 'c1' } }));
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.message).toMatch(/successfully cast/i);
  });

  test('returns 409 when voter has already voted (transaction conflict)', async () => {
    const now = new Date();
    const startTime = new Date(now.getTime() - 1000 * 60 * 60).toISOString();
    const endTime = new Date(now.getTime() + 1000 * 60 * 60).toISOString();

    ddbMock
      .on(GetCommand)
      .resolvesOnce({ Item: { electionId: 'e1', status: 'OPEN', startTime, endTime } })
      .resolvesOnce({ Item: { electionId: 'e1', candidateId: 'c1', name: 'Candidate One' } });

    const conflict = new Error('Transaction cancelled');
    conflict.name = 'TransactionCanceledException';
    ddbMock.on(TransactWriteCommand).rejects(conflict);

    const res = await handler(makeEvent({ body: { electionId: 'e1', candidateId: 'c1' } }));
    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.body);
    expect(body.message).toMatch(/already voted/i);
  });
});
