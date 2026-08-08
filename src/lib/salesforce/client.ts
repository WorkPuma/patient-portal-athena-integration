import { getSalesforceToken, getSalesforceApiUrl } from '@/lib/auth/salesforce';

/** Salesforce sObject metadata from the Describe API. */
export interface SObject {
    name: string;
    label: string;
    custom: boolean;
    createable: boolean;
}

/** Salesforce field metadata from the Describe API. */
export interface SField {
    name: string;
    label: string;
    type: string;
    createable: boolean;
    nillable: boolean;
    picklistValues?: { value: string; label: string; active: boolean }[];
}

/**
 * Escape a string for safe use in SOQL queries.
 * Prevents SOQL injection by escaping characters that have special meaning.
 */
export function escapeSoql(value: string): string {
    return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/** A single item from a Salesforce REST error response body. */
export interface SalesforceErrorItem {
    message: string;
    errorCode: string;
    fields?: string[];
}

function parseSalesforceErrorBody(bodyText: string): SalesforceErrorItem[] | null {
    try {
        const parsed = JSON.parse(bodyText);
        const arr: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
        if (arr.length === 0) return null;
        const items = arr
            .filter(
                (x): x is { message: unknown; errorCode: unknown; fields?: unknown } =>
                    !!x && typeof x === 'object' && typeof (x as { errorCode?: unknown }).errorCode === 'string',
            )
            .map((x) => ({
                message: typeof x.message === 'string' ? x.message : '',
                errorCode: x.errorCode as string,
                fields: Array.isArray(x.fields) ? (x.fields as string[]) : [],
            }));
        return items.length > 0 ? items : null;
    } catch {
        return null;
    }
}

/**
 * Error thrown when a Salesforce REST API call returns a non-2xx status.
 *
 * Carries the parsed SF error body so callers can map known errorCodes
 * (DUPLICATES_DETECTED, FIELD_CUSTOM_VALIDATION_EXCEPTION,
 * INVALID_CROSS_REFERENCE_KEY, REQUIRED_FIELD_MISSING, …) to the right HTTP
 * response instead of a generic 500. `message` keeps the legacy
 * `Salesforce API error: <status> - <body>` shape so existing string-based
 * handlers keep working.
 */
export class SalesforceApiError extends Error {
    readonly status: number;
    readonly body: SalesforceErrorItem[] | null;

    constructor(status: number, bodyText: string) {
        const items = parseSalesforceErrorBody(bodyText);
        const bodyForMessage = items ? JSON.stringify(items) : bodyText;
        super(`Salesforce API error: ${status} - ${bodyForMessage}`);
        this.name = 'SalesforceApiError';
        this.status = status;
        this.body = items;
    }

    hasCode(code: string): boolean {
        return this.body?.some((e) => e.errorCode === code) ?? false;
    }

    /** First user-facing message from the SF error body, if any. */
    get firstMessage(): string | null {
        return this.body?.find((e) => e.message)?.message ?? null;
    }
}

/**
 * Salesforce API Client
 * Uses server-side credentials for form submissions
 */
export class SalesforceClient {
    private accessToken: string;
    private instanceUrl: string;

    constructor(accessToken: string, instanceUrl: string) {
        this.accessToken = accessToken;
        this.instanceUrl = instanceUrl;
    }

    /**
     * Creates a client from environment credentials
     */
    static async fromEnvironment(): Promise<SalesforceClient | null> {
        const credentials = await getSalesforceToken();
        if (!credentials) return null;

        return new SalesforceClient(credentials.accessToken, credentials.instanceUrl);
    }

    /**
     * Make a request to Salesforce API
     */
    async request<T>(path: string, options: RequestInit = {}): Promise<T> {
        const apiUrl = getSalesforceApiUrl(this.instanceUrl);
        const response = await fetch(`${apiUrl}${path}`, {
            ...options,
            headers: {
                'Authorization': `Bearer ${this.accessToken}`,
                'Content-Type': 'application/json',
                ...options.headers,
            },
        });

        if (!response.ok) {
            const error = await response.text();
            throw new SalesforceApiError(response.status, error);
        }

        return response.json();
    }

    /**
     * Get list of creatable Salesforce objects
     */
    async getObjects(): Promise<SObject[]> {
        const result = await this.request<{ sobjects: SObject[] }>('/sobjects');

        // Filter to commonly used objects and custom objects
        const standardObjects = ['Lead', 'Contact', 'Account', 'Case', 'Opportunity', 'CampaignMember'];
        return result.sobjects.filter(obj =>
            obj.createable && (obj.custom || standardObjects.includes(obj.name))
        );
    }

    /**
     * Get fields for a specific Salesforce object
     */
    async getFields(objectName: string): Promise<SField[]> {
        const result = await this.request<{ fields: SField[] }>(`/sobjects/${objectName}/describe`);
        return result.fields.filter(f => f.createable);
    }

    /**
     * Create a record in Salesforce.
     *
     * `allowDuplicateRule`: when true, sends the `Sforce-Duplicate-Rule-Header:
     * allowSave=true` request header so duplicate rules with `allowSave=true`
     * (e.g. EMPI_Account_Duplicate_Check) save the record anyway. Required
     * when the org has an EMPI dedup rule that flags every PersonAccount
     * sharing an Athena id with an existing record.
     */
    async createRecord(
        objectName: string,
        data: Record<string, unknown>,
        options: { allowDuplicateRule?: boolean } = {},
    ): Promise<{ id: string; success: boolean }> {
        const headers: Record<string, string> = {};
        if (options.allowDuplicateRule) {
            headers['Sforce-Duplicate-Rule-Header'] = 'allowSave=true';
        }
        return this.request<{ id: string; success: boolean }>(
            `/sobjects/${objectName}`,
            { method: 'POST', body: JSON.stringify(data), headers },
        );
    }

    /**
     * Update a record in Salesforce
     */
    async updateRecord(objectName: string, recordId: string, data: Record<string, unknown>): Promise<void> {
        const apiUrl = getSalesforceApiUrl(this.instanceUrl);
        const response = await fetch(`${apiUrl}/sobjects/${objectName}/${recordId}`, {
            method: 'PATCH',
            headers: {
                'Authorization': `Bearer ${this.accessToken}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(data),
        });

        if (!response.ok) {
            const error = await response.text();
            throw new SalesforceApiError(response.status, error);
        }
    }

    /**
     * Delete a record from Salesforce
     */
    async deleteRecord(objectName: string, recordId: string): Promise<void> {
        const apiUrl = getSalesforceApiUrl(this.instanceUrl);
        const response = await fetch(`${apiUrl}/sobjects/${objectName}/${recordId}`, {
            method: 'DELETE',
            headers: {
                'Authorization': `Bearer ${this.accessToken}`,
            },
        });

        if (!response.ok) {
            const error = await response.text();
            throw new SalesforceApiError(response.status, error);
        }
    }

    /**
     * Query Salesforce records using SOQL
     */
    async query<T = Record<string, unknown>>(soql: string): Promise<{ records: T[]; totalSize: number }> {
        const encodedQuery = encodeURIComponent(soql);
        return this.request<{ records: T[]; totalSize: number }>(`/query?q=${encodedQuery}`);
    }

    /**
     * Get a specific record by ID
     */
    async getRecord<T = Record<string, unknown>>(objectName: string, recordId: string, fields?: string[]): Promise<T> {
        const fieldParam = fields ? `?fields=${fields.join(',')}` : '';
        return this.request<T>(`/sobjects/${objectName}/${recordId}${fieldParam}`);
    }

    /**
     * Get Campaign details with member count
     * Requires FLS access to Event_Capacity__c, Event_Start_DateTime__c, Event_End_DateTime__c on Campaign
     */
    async getCampaignWithMemberCount(campaignId: string): Promise<{
        campaign: Record<string, unknown>;
        memberCount: number;
    }> {
        const [campaignResult, countResult] = await Promise.all([
            this.query<Record<string, unknown>>(
                `SELECT Id, Name, Type, IsActive, Event_Capacity__c, Event_Start_DateTime__c, Event_End_DateTime__c FROM Campaign WHERE Id = '${escapeSoql(campaignId)}' LIMIT 1`
            ),
            this.query(`SELECT COUNT(Id) cnt FROM CampaignMember WHERE CampaignId = '${escapeSoql(campaignId)}'`),
        ]);

        if (campaignResult.totalSize === 0) {
            throw new Error(`Campaign not found: ${campaignId}`);
        }

        return {
            campaign: campaignResult.records[0],
            memberCount: (countResult.records[0] as { cnt: number })?.cnt || 0,
        };
    }

    /**
     * Check if a Lead/Contact is already a Campaign Member
     */
    async isAlreadyRegistered(campaignId: string, email: string): Promise<boolean> {
        const result = await this.query(
            `SELECT Id FROM CampaignMember WHERE CampaignId = '${escapeSoql(campaignId)}' AND Email = '${escapeSoql(email)}' LIMIT 1`
        );
        return result.totalSize > 0;
    }

    /**
     * Create or find a Lead and add as Campaign Member
     * @deprecated Use registerForCampaignWithEventSource for event registrations
     */
    async registerForCampaign(
        campaignId: string,
        registrationData: {
            firstName: string;
            lastName: string;
            email: string;
            phone?: string;
            company?: string;
        },
        status: string = 'Registered'
    ): Promise<{ leadId: string; campaignMemberId: string; isWaitlist: boolean }> {
        // First, check if Lead exists
        const existingLeads = await this.query<{ Id: string }>(
            `SELECT Id FROM Lead WHERE Email = '${escapeSoql(registrationData.email)}' LIMIT 1`
        );

        let leadId: string;

        if (existingLeads.totalSize > 0) {
            leadId = existingLeads.records[0].Id;
        } else {
            // Create new Lead
            const leadResult = await this.createRecord('Lead', {
                FirstName: registrationData.firstName,
                LastName: registrationData.lastName,
                Email: registrationData.email,
                Phone: registrationData.phone,
                Company: registrationData.company || 'Individual',
                LeadSource: 'Event Registration',
            });
            leadId = leadResult.id;
        }

        // Get current campaign capacity
        const { campaign, memberCount } = await this.getCampaignWithMemberCount(campaignId);
        const capacity = campaign.Event_Capacity__c as number | undefined;
        // Treat 0, null, or undefined capacity as unlimited (no waitlist)
        const isWaitlist = Boolean(capacity && capacity > 0 && memberCount >= capacity);

        // Create Campaign Member
        const memberResult = await this.createRecord('CampaignMember', {
            CampaignId: campaignId,
            LeadId: leadId,
            Status: isWaitlist ? 'Waitlist' : status,
        });

        return {
            leadId,
            campaignMemberId: memberResult.id,
            isWaitlist,
        };
    }

    /**
     * Register for campaign with proper Event source tracking
     *
     * Creates a Lead with:
     * - LeadSource = "Event"
     * - Campaign__c = campaignId (links Lead to the Campaign)
     * - UTM parameters if provided
     * - SMS consent if provided
     *
     * Then creates CampaignMember to formally register for the event
     */
    async registerForCampaignWithEventSource(
        campaignId: string,
        registrationData: {
            firstName: string;
            lastName: string;
            email: string;
            phone?: string;
            company?: string;
            smsConsent?: boolean;
            utmData?: {
                utm_source?: string | null;
                utm_medium?: string | null;
                utm_campaign?: string | null;
                utm_content?: string | null;
                utm_term?: string | null;
                utm_id?: string | null;
            };
        },
        status: string = 'Registered'
    ): Promise<{ leadId: string; campaignMemberId: string; isWaitlist: boolean }> {
        // First, check if Lead exists
        const existingLeads = await this.query<{ Id: string }>(
            `SELECT Id FROM Lead WHERE Email = '${escapeSoql(registrationData.email)}' LIMIT 1`
        );

        let leadId: string;
        const isNewLead = existingLeads.totalSize === 0;

        if (isNewLead) {
            // Build Lead data with Event source
            // Note: CampaignId on Lead is read-only (set via CampaignMember), so we use Source_Campaign__c for reference
            const leadData: Record<string, unknown> = {
                FirstName: registrationData.firstName,
                LastName: registrationData.lastName,
                Email: registrationData.email,
                Company: registrationData.company || 'Individual',
                LeadSource: 'Event',
                Source_Campaign__c: campaignId, // Reference to the Campaign (CampaignId is set via CampaignMember)
            };

            // Add phone if provided
            if (registrationData.phone) {
                leadData.MobilePhone = registrationData.phone;
            }

            // Add SMS consent if provided
            if (registrationData.smsConsent !== undefined) {
                leadData.SMS_Consent__c = registrationData.smsConsent;
            }

            // Add UTM parameters if provided
            if (registrationData.utmData) {
                const utm = registrationData.utmData;
                if (utm.utm_source) leadData.utm_source__c = utm.utm_source;
                if (utm.utm_medium) leadData.utm_medium__c = utm.utm_medium;
                if (utm.utm_campaign) leadData.utm_campaign__c = utm.utm_campaign;
                if (utm.utm_content) leadData.utm_content__c = utm.utm_content;
                if (utm.utm_term) leadData.utm_term__c = utm.utm_term;
                if (utm.utm_id) leadData.utm_id__c = utm.utm_id;
            }

            // Create new Lead
            const leadResult = await this.createRecord('Lead', leadData);
            leadId = leadResult.id;
        } else {
            leadId = existingLeads.records[0].Id;

            // Optionally update existing Lead with Source_Campaign__c if not already set
            // This ensures the Lead is linked to this event even if they existed before
            try {
                await this.updateRecord('Lead', leadId, {
                    Source_Campaign__c: campaignId,
                });
            } catch (err) {
                // Ignore update errors - Lead might already have a Source_Campaign__c value
                console.warn('Could not update Lead Source_Campaign__c:', err);
            }
        }

        // Get current campaign capacity
        const { campaign, memberCount } = await this.getCampaignWithMemberCount(campaignId);
        const capacity = campaign.Event_Capacity__c as number | undefined;
        // Treat 0, null, or undefined capacity as unlimited (no waitlist)
        const isWaitlist = Boolean(capacity && capacity > 0 && memberCount >= capacity);

        // Create Campaign Member
        const memberResult = await this.createRecord('CampaignMember', {
            CampaignId: campaignId,
            LeadId: leadId,
            Status: isWaitlist ? 'Waitlist' : status,
        });

        return {
            leadId,
            campaignMemberId: memberResult.id,
            isWaitlist,
        };
    }
}
