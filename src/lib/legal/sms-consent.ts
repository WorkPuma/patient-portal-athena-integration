/**
 * Canonical A2P / carrier SMS opt-in disclosure for Herself Health forms.
 * Keep this in sync across portal, Storyblok forms, and legacy landing pages.
 */

export const SMS_CONSENT_CHECKBOX_TEXT =
  "By selecting this checkbox you consent to receive informational text messages (appointment confirmation and reminder messages) from Herself Health at the number provided. Consent is not a condition of purchase. Message & data rates may apply. Message frequency varies. Reply HELP for help. Unsubscribe at any time by replying STOP.";

/** Same-site paths used on marketing and portal forms. */
export const PRIVACY_POLICY_HREF = "/privacy-policy";
export const TERMS_OF_SERVICE_HREF = "/terms-and-conditions";

/** Absolute URLs for legacy compiled landing bundles (open in new tab). */
export const PRIVACY_POLICY_ABSOLUTE_HREF =
  "https://www.example-patient-portal.com/privacy-policy";
export const TERMS_OF_SERVICE_ABSOLUTE_HREF =
  "https://www.example-patient-portal.com/terms-and-conditions";

/** True when a form-builder checkbox field is the SMS opt-in control. */
export function isSmsConsentFieldName(fieldName: string | undefined): boolean {
  if (!fieldName) return false;
  const n = fieldName.trim().toLowerCase();
  return (
    n === "smsconsent" ||
    n === "sms_consent__c" ||
    n === "sms" ||
    n === "consenttotext" ||
    n === "consent_to_text"
  );
}
