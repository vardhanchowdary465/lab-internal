/**
 * Minimal Cognito auth client using direct calls to the AWS Cognito
 * Identity Provider service (no Amplify/SDK bundle required -- this
 * keeps the frontend a plain set of static files deployable straight
 * to S3, matching the project's "serverless, no build step" goal).
 *
 * Docs: https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-identity-pools-using-the-api.html
 */

const Auth = (() => {
  const cognitoConfig = window.VOTING_CONFIG?.cognito;
  if (!cognitoConfig || !cognitoConfig.region || !cognitoConfig.clientId || !cognitoConfig.userPoolId) {
    throw new Error('Cognito configuration is missing. Update frontend/js/config.js with the deployed UserPoolId and ClientId.');
  }

  const { region, clientId, userPoolId } = cognitoConfig;
  const ENDPOINT = `https://cognito-idp.${region}.amazonaws.com/`;

  if (!userPoolId || !clientId) {
    throw new Error('Invalid Cognito config: userPoolId and clientId must be set.');
  }

  async function cognitoRequest(target, payload) {
    try {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        mode: 'cors',
        cache: 'no-store',
        headers: {
          'Content-Type': 'application/x-amz-json-1.1',
          'X-Amz-Target': `AWSCognitoIdentityProviderService.${target}`,
        },
        body: JSON.stringify(payload),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.message || data.__type || 'Authentication request failed');
      }
      return data;
    } catch (err) {
      if (err instanceof TypeError) {
        throw new Error('Failed to reach Cognito. Check the app client auth flow, browser network, and that the frontend is served from localhost:8000.');
      }
      throw err;
    }
  }

  function saveSession(authResult) {
    localStorage.setItem('voting_id_token', authResult.IdToken);
    localStorage.setItem('voting_access_token', authResult.AccessToken);
    localStorage.setItem('voting_refresh_token', authResult.RefreshToken);
  }

  function clearSession() {
    localStorage.removeItem('voting_id_token');
    localStorage.removeItem('voting_access_token');
    localStorage.removeItem('voting_refresh_token');
  }

  function getIdToken() {
    return localStorage.getItem('voting_id_token');
  }

  function decodeIdToken() {
    const token = getIdToken();
    if (!token) return null;
    try {
      const payload = token.split('.')[1];
      return JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')));
    } catch {
      return null;
    }
  }

  function isAuthenticated() {
    const claims = decodeIdToken();
    if (!claims) return false;
    return claims.exp * 1000 > Date.now();
  }

  async function signUp({ email, password, fullName }) {
    return cognitoRequest('SignUp', {
      ClientId: clientId,
      Username: email,
      Password: password,
      UserAttributes: [
        { Name: 'email', Value: email },
        { Name: 'name', Value: fullName },
      ],
    });
  }

  async function confirmSignUp({ email, code }) {
    return cognitoRequest('ConfirmSignUp', {
      ClientId: clientId,
      Username: email,
      ConfirmationCode: code,
    });
  }

  async function signIn({ email, password }) {
    const data = await cognitoRequest('InitiateAuth', {
      AuthFlow: 'USER_PASSWORD_AUTH',
      ClientId: clientId,
      AuthParameters: {
        USERNAME: email,
        PASSWORD: password,
      },
    });
    saveSession(data.AuthenticationResult);
    return data;
  }

  function signOut() {
    clearSession();
  }

  return {
    signUp,
    confirmSignUp,
    signIn,
    signOut,
    getIdToken,
    decodeIdToken,
    isAuthenticated,
  };
})();
