export interface OidcTokenRequest {
  issuerUrl: string;
  clientId: string;
  username: string;
  password: string;
  clientSecret?: string;
}

export interface OidcTokenResponse {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  tokenType: string;
}

export async function getOidcToken(opts: OidcTokenRequest): Promise<OidcTokenResponse> {
  const params = new URLSearchParams({
    grant_type: 'password',
    client_id: opts.clientId,
    username: opts.username,
    password: opts.password,
    scope: 'openid',
  });

  if (opts.clientSecret) {
    params.set('client_secret', opts.clientSecret);
  }

  const response = await fetch(
    `${opts.issuerUrl}/protocol/openid-connect/token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    },
  );

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`OIDC token request failed (${response.status}): ${errorBody}`);
  }

  const data = await response.json();

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresIn: data.expires_in,
    tokenType: data.token_type,
  };
}
