/**
 * Tests for the no-account RegistrationWizard.
 *
 * The wizard now POSTs to /api/portal/register/patient and routes the user
 * straight to /register/eligibility (no Clerk sign-up gate). These tests
 * cover the happy path, the duplicate-detection branch, and basic field
 * validation. We mock the registration-client module so we don't need to
 * boot Upstash or jose in jsdom.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

// Radix Select / Popover read scrollIntoView, hasPointerCapture, etc., none of
// which exist in jsdom. Stub them once before any test renders the wizard.
beforeAll(() => {
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = function noop() { };
  }
  if (!Element.prototype.hasPointerCapture) {
    Element.prototype.hasPointerCapture = () => false as unknown as boolean;
  }
  if (!Element.prototype.releasePointerCapture) {
    Element.prototype.releasePointerCapture = function noop() { };
  }
  if (!HTMLElement.prototype.setPointerCapture) {
    HTMLElement.prototype.setPointerCapture = function noop() { };
  }
});

const mockPush = vi.fn();
const mockRegisterFetch = vi.fn();
const mockSaveRegistration = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: mockPush,
    replace: vi.fn(),
    prefetch: vi.fn(),
    back: vi.fn(),
  }),
}));

vi.mock("@/lib/portal", () => ({
  getPortalDefaultDepartmentId: () => 2,
}));

vi.mock("@/lib/tracking/posthog-consent", () => ({
  recordRegistrationAnalyticsConsent: vi.fn(),
}));

// Toggleable feature flags for the wizard. Default to the legacy
// "everything on" state so existing assertions pass; tests that exercise
// the flagged-off behavior overwrite `flagsState` before rendering.
const flagsState = { dot: false, membership: true, authUi: true };
vi.mock("@/lib/portal/feature-flags", () => ({
  getClientPortalFeatureFlags: () => ({ ...flagsState }),
  getPortalFeatureFlags: () => ({ ...flagsState, passiveClerk: true }),
  getPublicPortalFeatureFlags: () => ({ ...flagsState }),
}));

vi.mock("./registration-client", () => ({
  registerFetch: (...args: unknown[]) => mockRegisterFetch(...args),
  saveRegistration: (...args: unknown[]) => mockSaveRegistration(...args),
  loadRegistration: () => null,
  clearRegistration: vi.fn(),
  // Draft persistence is exercised by browser-only paths; in tests we just
  // need the wizard to find these symbols. Returning `null` keeps the form
  // on its hard-coded defaults so existing assertions stay valid.
  loadRegistrationDraft: () => null,
  saveRegistrationDraft: vi.fn(),
}));

// Replace Radix Select with a plain native <select> so we can drive it from
// jsdom without polyfilling pointer/scroll APIs. The wizard only depends on
// onValueChange firing with "F" or "M" (or a state code).
vi.mock("@/components/ui/select", () => {
  // We render the mock as a native <select> and forward the id +
  // aria-label from the nested SelectTrigger up to the <select> so
  // getByLabelText() works for the DOB month / day / year fields. This
  // is implemented by stashing the trigger's id/aria-label on a module
  // variable that's consumed by the next <Select> render — Radix's
  // shape doesn't pass them as props, but they're consistently the
  // first child of the Select children tree.
  // We accomplish this by walking children at render time.
  type SelectTriggerProps = {
    id?: string;
    "aria-label"?: string;
    children: React.ReactNode;
  };
  const Select = ({
    value,
    onValueChange,
    children,
  }: {
    value?: string;
    onValueChange?: (v: string) => void;
    children: React.ReactNode;
  }) => {
    let selectId: string | undefined;
    let ariaLabel: string | undefined;
    const arr = Array.isArray(children) ? children : [children];
    for (const child of arr) {
      if (
        child &&
        typeof child === "object" &&
        "props" in (child as object)
      ) {
        const props = (child as { props?: SelectTriggerProps }).props;
        if (props && (props.id || props["aria-label"])) {
          selectId = props.id;
          ariaLabel = props["aria-label"];
          break;
        }
      }
    }
    return (
      <select
        id={selectId}
        aria-label={ariaLabel}
        value={value ?? ""}
        onChange={(e) => onValueChange?.(e.target.value)}
      >
        <option value="" disabled>
          Select
        </option>
        {children}
      </select>
    );
  };
  const SelectTrigger = ({
    children,
  }: {
    children: React.ReactNode;
    id?: string;
    "aria-label"?: string;
  }) => <>{children}</>;
  const SelectContent = ({ children }: { children: React.ReactNode }) => <>{children}</>;
  const SelectItem = ({
    value,
    children,
  }: {
    value: string;
    children: React.ReactNode;
  }) => <option value={value}>{children}</option>;
  const SelectValue = () => null;
  return { Select, SelectTrigger, SelectContent, SelectItem, SelectValue };
});

vi.mock("next/link", () => ({
  default: ({
    children,
    href,
    ...props
  }: {
    children: React.ReactNode;
    href: string;
    [key: string]: unknown;
  }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

import { RegistrationWizard } from "./RegistrationWizard";

function fillRequiredFields() {
  fireEvent.change(screen.getByLabelText(/first name/i), {
    target: { value: "Jane" },
  });
  fireEvent.change(screen.getByLabelText(/last name/i), {
    target: { value: "Doe" },
  });
  // DOB is now three Selects (Month / Day / Year). The mock forwards
  // aria-label from each SelectTrigger so we can drive each field
  // independently. Set 1960-01-15.
  fireEvent.change(screen.getByLabelText(/birth month/i), {
    target: { value: "01" },
  });
  fireEvent.change(screen.getByLabelText(/birth day/i), {
    target: { value: "15" },
  });
  fireEvent.change(screen.getByLabelText(/birth year/i), {
    target: { value: "1960" },
  });
  fireEvent.change(screen.getByLabelText(/email/i), {
    target: { value: "jane@example.com" },
  });
  fireEvent.change(screen.getByLabelText(/mobile phone/i), {
    target: { value: "+15551234567" },
  });

  // DEV-4023 added two more required fields on the demographics step.
  // Answer Medicare = "yes" (Radix RadioGroupItem renders as a button) so
  // the form doesn't off-ramp non-Medicare patients before submission.
  const medicareYes = document.getElementById("medicare-yes");
  if (medicareYes) fireEvent.click(medicareYes);

  // Pick "Doctor Referral" from the referral source dropdown. The Select
  // mock drops the `id` prop on SelectTrigger, so we identify the right
  // <select> by one of its known REFERRAL_OPTIONS values (same trick
  // selectFemale() uses for the sex dropdown).
  const referralSelect = Array.from(
    document.querySelectorAll<HTMLSelectElement>("select")
  ).find((el) => !!el.querySelector('option[value="Doctor Referral"]'));
  if (referralSelect) {
    fireEvent.change(referralSelect, { target: { value: "Doctor Referral" } });
  }
}

function selectFemale() {
  // Our Select mock renders a native <select> with the Female option.
  const selects = Array.from(
    document.querySelectorAll<HTMLSelectElement>("select")
  );
  const sexSelect = selects.find((el) => !!el.querySelector('option[value="F"]'));
  if (!sexSelect) throw new Error("Could not find sex select");
  fireEvent.change(sexSelect, { target: { value: "F" } });
}

describe("RegistrationWizard (no-account flow)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset flag state to "everything on" between tests so individual
    // tests can opt into the flagged-off behavior without leaking state.
    flagsState.membership = true;
    flagsState.authUi = true;
  });

  describe("renders the form", () => {
    it("shows the demographics fields", () => {
      render(<RegistrationWizard />);

      expect(screen.getByText("Schedule your first visit")).toBeInTheDocument();
      expect(screen.getByLabelText(/first name/i)).toBeInTheDocument();
      expect(screen.getByLabelText(/last name/i)).toBeInTheDocument();
      expect(screen.getByText(/^Date of birth \*$/i)).toBeInTheDocument();
      expect(screen.getByLabelText(/birth month/i)).toBeInTheDocument();
      expect(screen.getByLabelText(/birth day/i)).toBeInTheDocument();
      expect(screen.getByLabelText(/birth year/i)).toBeInTheDocument();
      expect(screen.getByText(/^Sex \*$/i)).toBeInTheDocument();
      expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
      expect(screen.getByLabelText(/mobile phone/i)).toBeInTheDocument();
    });

    it("renders all four step indicators", () => {
      render(<RegistrationWizard />);

      expect(screen.getByText("Your info")).toBeInTheDocument();
      expect(screen.getByText("Insurance")).toBeInTheDocument();
      expect(screen.getByText("Membership")).toBeInTheDocument();
      expect(screen.getByText("Choose a visit time")).toBeInTheDocument();
    });

    it("links to /login for returning users", () => {
      render(<RegistrationWizard />);

      // Visible copy reads "Already registered? Sign in" — the <Link>
      // only wraps "Sign in", so look up the link by its own
      // accessible name.
      expect(screen.getByText(/already registered\?/i)).toBeInTheDocument();
      const link = screen.getByRole("link", { name: /^sign in$/i });
      expect(link).toHaveAttribute("href", "/login");
    });

    it("explains that an account is not required", () => {
      render(<RegistrationWizard />);
      expect(
        screen.getByText(/without creating an account/i)
      ).toBeInTheDocument();
    });
  });

  describe("with feature flags off (current default build)", () => {
    beforeEach(() => {
      flagsState.membership = false;
      flagsState.authUi = false;
    });

    it("renders only three step indicators when membership is off", () => {
      render(<RegistrationWizard />);
      expect(screen.getByText("Your info")).toBeInTheDocument();
      expect(screen.getByText("Insurance")).toBeInTheDocument();
      expect(screen.getByText("Choose a visit time")).toBeInTheDocument();
      expect(screen.queryByText("Membership")).not.toBeInTheDocument();
    });

    it("hides the 'Already registered? Sign in' link when authUi is off", () => {
      render(<RegistrationWizard />);
      expect(
        screen.queryByRole("link", { name: /already registered.*sign in/i })
      ).not.toBeInTheDocument();
    });

    it("hides the 'no account required' helper copy when authUi is off", () => {
      render(<RegistrationWizard />);
      expect(
        screen.queryByText(/without creating an account/i)
      ).not.toBeInTheDocument();
    });
  });

  describe("client-side validation", () => {
    it("requires sex (when explicitly cleared)", async () => {
      // The form defaults sex to "F" (matches the practice's predominantly-
      // female panel and Dot's default). To exercise the validation path we
      // clear the field first.
      render(<RegistrationWizard />);
      fillRequiredFields();

      const sexSelect = Array.from(
        document.querySelectorAll<HTMLSelectElement>("select")
      ).find((el) => !!el.querySelector('option[value="F"]'));
      if (!sexSelect) throw new Error("Could not find sex select");
      fireEvent.change(sexSelect, { target: { value: "" } });

      fireEvent.click(screen.getByText("Continue"));

      await waitFor(() => {
        expect(screen.getByText("Please select sex.")).toBeInTheDocument();
      });
      expect(mockRegisterFetch).not.toHaveBeenCalled();
    });


    it("requires email (membership step refuses to enroll without one)", async () => {
      render(<RegistrationWizard />);
      fillRequiredFields();
      selectFemale();
      fireEvent.change(screen.getByLabelText(/email/i), {
        target: { value: "" },
      });
      fireEvent.click(screen.getByText("Continue"));
      await waitFor(() => {
        expect(
          screen.getByText(/Please enter your email address/i)
        ).toBeInTheDocument();
      });
      expect(mockRegisterFetch).not.toHaveBeenCalled();
    });

    it("rejects an obviously bad email address", async () => {
      render(<RegistrationWizard />);
      fillRequiredFields();
      selectFemale();
      fireEvent.change(screen.getByLabelText(/email/i), {
        target: { value: "not-an-email" },
      });
      fireEvent.click(screen.getByText("Continue"));
      await waitFor(() => {
        expect(
          screen.getByText(/valid email address/i)
        ).toBeInTheDocument();
      });
      expect(mockRegisterFetch).not.toHaveBeenCalled();
    });

    it("rejects an obviously bad phone number", async () => {
      render(<RegistrationWizard />);
      fillRequiredFields();
      fireEvent.change(screen.getByLabelText(/mobile phone/i), {
        target: { value: "not-a-number" },
      });
      fireEvent.click(screen.getByText("Continue"));
      await waitFor(() => {
        expect(
          screen.getByText(/valid 10-digit mobile phone/i)
        ).toBeInTheDocument();
      });
      expect(mockRegisterFetch).not.toHaveBeenCalled();
    });
  });

  describe("submission", () => {
    it("redirects users with a duplicate Athena match to sign in (no patientId leaked)", async () => {
      mockRegisterFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        data: {
          duplicate: true,
          message:
            "We may already have a record for you. Please sign in to continue.",
        },
      });

      render(<RegistrationWizard />);
      fillRequiredFields();
      selectFemale();

      fireEvent.click(screen.getByText("Continue"));

      await waitFor(() => {
        expect(
          screen.getByText(/looks like you're already with us/i)
        ).toBeInTheDocument();
      });

      expect(mockSaveRegistration).not.toHaveBeenCalled();
      expect(mockPush).not.toHaveBeenCalled();
    });

    it("saves the regToken and routes to /register/eligibility on success", async () => {
      mockRegisterFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        data: {
          patientId: "12345",
          hintPatientId: "h-99",
          regToken: "tok.tok.tok",
        },
      });

      render(<RegistrationWizard />);
      fillRequiredFields();
      selectFemale();

      fireEvent.click(screen.getByText("Continue"));

      await waitFor(() => {
        expect(mockRegisterFetch).toHaveBeenCalledWith(
          "/api/portal/register/patient",
          expect.objectContaining({ method: "POST" })
        );
      });

      await waitFor(() => {
        expect(mockSaveRegistration).toHaveBeenCalledWith(
          expect.objectContaining({
            regToken: "tok.tok.tok",
            patientId: "12345",
            hintPatientId: "h-99",
            firstName: "Jane",
            lastName: "Doe",
            email: "jane@example.com",
            phone: "+15551234567",
          })
        );
      });

      expect(mockPush).toHaveBeenCalledWith("/register/eligibility");
    });

    it("surfaces a friendly error when the API returns one", async () => {
      mockRegisterFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        data: null,
        error: { error: "Athena exploded" },
      });

      render(<RegistrationWizard />);
      fillRequiredFields();
      selectFemale();

      fireEvent.click(screen.getByText("Continue"));

      await waitFor(() => {
        expect(screen.getByText("Athena exploded")).toBeInTheDocument();
      });
      expect(mockPush).not.toHaveBeenCalled();
    });
  });
});
