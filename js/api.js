/**
 * Thin fetch wrapper around the Voting API (API Gateway + Lambda).
 * Attaches the Cognito ID token as a Bearer credential on every call,
 * since all routes sit behind the CognitoAuthorizer in template.yaml.
 */

const Api = (() => {
  const { apiBaseUrl } = window.VOTING_CONFIG;

  async function request(path, { method = 'GET', body } = {}) {
    const token = Auth.getIdToken();
    const res = await fetch(`${apiBaseUrl}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: token } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.message || `Request failed (${res.status})`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  return {
    registerVoter: (profile) => request('/voters/register', { method: 'POST', body: profile }),
    getCandidates: (electionId) => request(`/elections/${electionId}/candidates`),
    castVote: (electionId, candidateId) =>
      request('/votes', { method: 'POST', body: { electionId, candidateId } }),
    getResults: (electionId) => request(`/elections/${electionId}/results`),
  };
})();
