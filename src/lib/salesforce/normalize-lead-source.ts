/**
 * Server-side LeadSource normalization for Salesforce.
 *
 * Maps the messy universe of raw LeadSource values (from UTM params,
 * legacy landing pages, manual entry, etc.) down to the controlled
 * picklist we actually want in Salesforce.
 *
 * Canonical values (target picklist):
 *   - Purchased List        (bulk import lists)
 *   - Direct Mail           (directmail, mail landing pages, Veezla)
 *   - Facebook              (fb, facebook, meta, Facebook Events)
 *   - Google                (google, google.com)
 *   - Website               (default for organic web forms)
 *   - Membership            (member, membership, members landing pages)
 *   - Events                (Event, Eventbrite, Canvassing/Events, Facebook Events)
 *   - Instagram             (ig, instagram)
 *   - Television            (tv, Television)
 *   - Bing                  (bing)
 *   - Nextdoor              (nextdoor)
 *   - YouTube               (youtube)
 *   - Email                 (email landing pages)
 *   - Patient Referral      (Patient Referal typo, Patient Referral - NonProfit)
 *   - Cold Call
 *   - Senior Living
 *   - Walk-in
 *   - Insurance Agent/Broker
 *   - Insurance Portal
 *   - Healthcare Provider
 *   - BCBS
 *   - UCare
 *   - Word of Mouth         (Word of mouth → capitalize)
 *   - Billboard / Signage
 *   - Newspaper
 *   - Radio
 *   - Flyer
 *   - Community Partner
 *   - Programmatic          (simplifi, Geofenced Display → Programmatic)
 *   - New Patients          (newpatients landing page)
 *   - Guide                 (guide landing page)
 *   - Other                 (sanity, conciergewaitist, Unknown, an, etc.)
 */

const NORMALIZE_MAP: Record<string, string> = {
  // --- Direct Mail ---
  'directmail': 'Direct Mail',
  'Direct Mail': 'Direct Mail',
  'direct mail': 'Direct Mail',
  'mail': 'Direct Mail',
  'plum-grove': 'Direct Mail',
  'premier-print': 'Direct Mail',

  // --- Facebook ---
  'Facebook': 'Facebook',
  'facebook': 'Facebook',
  'fb': 'Facebook',
  'meta': 'Facebook',
  'Facebook Events': 'Facebook',
  'datasys_meta': 'Facebook',

  // --- Google ---
  'Google': 'Google',
  'google': 'Google',
  'GOOGLE': 'Google',
  'google.com': 'Google',

  // --- Instagram ---
  'Instagram': 'Instagram',
  'instagram': 'Instagram',
  'ig': 'Instagram',

  // --- Bing ---
  'bing': 'Bing',
  'Bing': 'Bing',

  // --- YouTube ---
  'youtube': 'YouTube',
  'YouTube': 'YouTube',

  // --- Nextdoor ---
  'nextdoor': 'Nextdoor',
  'Nextdoor': 'Nextdoor',

  // --- Yelp ---
  'yelp': 'Yelp',
  'Yelp': 'Yelp',

  // --- Television ---
  'tv': 'Television',
  'Television': 'Television',
  'television': 'Television',

  // --- Email ---
  'email': 'Email',
  'Email': 'Email',
  'sfmc': 'Email',
  'datasys_email': 'Email',
  'datasys': 'Email',

  // --- Website ---
  'Website': 'Website',
  'website': 'Website',

  // --- Membership ---
  'Membership': 'Membership',
  'membership': 'Membership',
  'member': 'Membership',
  'members': 'Membership',
  'member_waitlist': 'Membership',
  'membership_long': 'Membership',

  // --- Events ---
  'Events': 'Events',
  'Event': 'Events',
  'event': 'Events',
  'Eventbrite': 'Events',
  'eventbrite': 'Events',
  'Canvassing/Events': 'Events',
  'event_waitlist': 'Events',

  // --- New Patients ---
  'New Patients': 'New Patients',
  'newpatients': 'New Patients',
  'new patients': 'New Patients',

  // --- Guide ---
  'Guide': 'Guide',
  'guide': 'Guide',

  // --- care (multi-channel landing page: radio, newspaper, programmatic) ---
  'care': 'care',
  'Care': 'care',

  // --- Medicare ---
  'Medicare': 'Medicare',
  'medicare': 'Medicare',

  // --- Google Business Profile ---
  'gbp': 'Google Business Profile',
  'Google Business Profile': 'Google Business Profile',

  // --- Patient Referral ---
  'Patient Referral': 'Patient Referral',
  'Patient Referal': 'Patient Referral',
  'Patient Referral - NonProfit': 'Patient Referral',

  // --- Word of mouth (Salesforce picklist casing) ---
  'Word of mouth': 'Word of mouth',
  'word of mouth': 'Word of mouth',
  'Word of Mouth': 'Word of mouth',

  // --- Programmatic / Display ---
  'simplifi': 'Programmatic',
  'Programmatic': 'Programmatic',
  'Geofenced Display': 'Programmatic',
  'programmatic': 'Programmatic',
  'viant': 'Programmatic',

  // --- Purchased List ---
  'Purchased List': 'Purchased List',

  // --- Remaining pass-through (already canonical) ---
  'Cold Call': 'Cold Call',
  'Senior Living': 'Senior Living',
  'Walk-in': 'Walk-in',
  'Insurance Agent/Broker': 'Insurance Agent/Broker',
  'Insurance Portal': 'Insurance Portal',
  'Healthcare Provider': 'Healthcare Provider',
  'BCBS': 'BCBS',
  'UCare': 'UCare',
  'Billboard / Signage': 'Billboard / Signage',
  'Newspaper': 'Newspaper',
  'Radio': 'Radio',
  'Flyer': 'Flyer',
  'Community Partner': 'Community Partner',
  'MIDI Referral': 'MIDI Referral',
  'Other': 'Other',

  // --- Junk / legacy values → Other ---
  'sanity': 'Other',
  'an': 'Other',
  'conciergewaitist': 'Other',
  'Unknown': 'Other',
};

/**
 * Normalize a LeadSource value to the controlled Salesforce picklist.
 *
 * Lookup is case-sensitive on common values for speed, but falls back
 * to a case-insensitive search when not found. Unknown values pass
 * through unchanged so we never lose data.
 */
export function normalizeLeadSource(raw: string | null | undefined): string {
  if (!raw) return 'Website';

  const trimmed = raw.trim();
  if (!trimmed) return 'Website';

  if (NORMALIZE_MAP[trimmed]) {
    return NORMALIZE_MAP[trimmed];
  }

  const lower = trimmed.toLowerCase();
  for (const [key, value] of Object.entries(NORMALIZE_MAP)) {
    if (key.toLowerCase() === lower) {
      return value;
    }
  }

  // Unknown value — pass through so we can see it in reports and add it later
  return trimmed;
}

/**
 * The set of canonical LeadSource values we want in the Salesforce picklist.
 */
export const CANONICAL_LEAD_SOURCES = [
  'BCBS',
  'Billboard / Signage',
  'Bing',
  'care',
  'Cold Call',
  'Community Partner',
  'Direct Mail',
  'Email',
  'Events',
  'Facebook',
  'Flyer',
  'Google',
  'Google Business Profile',
  'Guide',
  'Healthcare Provider',
  'Instagram',
  'Insurance Agent/Broker',
  'Insurance Portal',
  'Medicare',
  'Membership',
  'MIDI Referral',
  'New Patients',
  'Nextdoor',
  'Newspaper',
  'Other',
  'Patient Referral',
  'Programmatic',
  'Purchased List',
  'Radio',
  'Senior Living',
  'Television',
  'UCare',
  'Walk-in',
  'Website',
  'Word of mouth',
  'Yelp',
  'YouTube',
] as const;
