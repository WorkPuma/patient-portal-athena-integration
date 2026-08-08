/**
 * Salesforce OAuth 2.0 Client Credentials Flow Authentication
 * 
 * This uses the Client Credentials flow for server-to-server authentication.
 * Requires a connected app with Client Credentials enabled in Salesforce.
 * The Connected App's "Run As" user determines the context for all operations.
 * 
 * Required env vars:
 * - SALESFORCE_CLIENT_ID: Connected App consumer key
 * - SALESFORCE_CLIENT_SECRET: Connected App consumer secret
 * - SALESFORCE_LOGIN_URL: Login URL (login.salesforce.com or test.salesforce.com)
 */

const SF_LOGIN_URL = process.env.SALESFORCE_LOGIN_URL || 'https://login.salesforce.com';
const SF_TOKEN_URL = `${SF_LOGIN_URL}/services/oauth2/token`;
const SF_CLIENT_ID = process.env.SALESFORCE_CLIENT_ID;
const SF_CLIENT_SECRET = process.env.SALESFORCE_CLIENT_SECRET;

interface SalesforceTokenResponse {
    access_token: string;
    instance_url: string;
    id: string;
    token_type: string;
    issued_at: string;
    signature: string;
}

// Cache for access token (server-side memory cache)
let tokenCache: {
    accessToken: string;
    instanceUrl: string;
    expiresAt: number;
} | null = null;

/**
 * Exchange client credentials for access token
 */
async function exchangeClientCredentialsForToken(): Promise<SalesforceTokenResponse> {
    if (!SF_CLIENT_ID || !SF_CLIENT_SECRET) {
        throw new Error('Missing Salesforce Client Credentials configuration');
    }

    const params = new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: SF_CLIENT_ID,
        client_secret: SF_CLIENT_SECRET
    });

    const response = await fetch(SF_TOKEN_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: params.toString()
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Salesforce token exchange failed: ${response.status} - ${errorText}`);
    }

    return response.json();
}

/**
 * Get Salesforce access token using Client Credentials flow
 */
export async function getSalesforceToken(): Promise<{
    accessToken: string;
    instanceUrl: string;
} | null> {
    // Check cache first (tokens are valid for ~2 hours)
    if (tokenCache && Date.now() < tokenCache.expiresAt) {
        return {
            accessToken: tokenCache.accessToken,
            instanceUrl: tokenCache.instanceUrl,
        };
    }

    // Check if Client Credentials are configured
    if (SF_CLIENT_ID && SF_CLIENT_SECRET) {
        try {
            const tokenResponse = await exchangeClientCredentialsForToken();
            
            tokenCache = {
                accessToken: tokenResponse.access_token,
                instanceUrl: tokenResponse.instance_url,
                expiresAt: Date.now() + 7200000, // 2 hours
            };

            return {
                accessToken: tokenResponse.access_token,
                instanceUrl: tokenResponse.instance_url,
            };
        } catch (error) {
            console.error('Salesforce Client Credentials authentication failed:', error);
            // Fall through to other methods
        }
    }

    // Fallback: If we have a pre-configured token (for development/testing)
    const preConfiguredToken = process.env.SALESFORCE_ACCESS_TOKEN;
    const preConfiguredInstanceUrl = process.env.SALESFORCE_INSTANCE_URL;

    if (preConfiguredToken && preConfiguredInstanceUrl) {
        tokenCache = {
            accessToken: preConfiguredToken,
            instanceUrl: preConfiguredInstanceUrl,
            expiresAt: Date.now() + 7200000, // 2 hours
        };
        return {
            accessToken: preConfiguredToken,
            instanceUrl: preConfiguredInstanceUrl,
        };
    }

    console.warn('Salesforce tokens not configured. Form submissions to Salesforce will fail.');
    console.warn('Configure Client Credentials (SALESFORCE_CLIENT_ID, SALESFORCE_CLIENT_SECRET) or pre-configured token (SALESFORCE_ACCESS_TOKEN)');
    return null;
}

/**
 * Get the Salesforce API base URL for making requests
 */
export function getSalesforceApiUrl(instanceUrl: string, apiVersion = 'v59.0'): string {
    return `${instanceUrl}/services/data/${apiVersion}`;
}