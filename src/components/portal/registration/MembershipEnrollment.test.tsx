/**
 * Unit tests for `MembershipEnrollment` PaymentStep.
 *
 * Validates the post-revert UX (agreement BELOW the iframe, single
 * purple-pill "Save card & continue" CTA driven by a forwarded ref):
 *
 *   1. CTA renders, is disabled before the agreement is checked.
 *   2. CTA enables once the agreement is checked.
 *   3. Clicking the CTA invokes `paymentFormRef.current.submit()` exactly
 *      once (proving we still drive the iframe via the ref instead of
 *      Rainforest's hidden inline button).
 *   4. While `attaching=true` the CTA is disabled and shows the spinner +
 *      "Saving…" label so the click doesn't feel like dead air.
 *
 * Rainforest is replaced with a fake forwardRef component that exposes a
 * spy-backed `submit()` so we can assert the wiring without booting the real
 * `<rainforest-payment>` web component (which requires a cross-origin iframe
 * and Rainforest's JS bundle, neither of which exist in jsdom).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { useRef, forwardRef, useImperativeHandle } from "react";

import { __PaymentStepForTesting as PaymentStep } from "./MembershipEnrollment";
import type { RainforestPaymentFormHandle } from "./RainforestPaymentForm";

const submitSpy = vi.fn();

vi.mock("./RainforestPaymentForm", () => {
  const FakeForm = forwardRef<RainforestPaymentFormHandle>(
    function FakeRainforestForm(_props, ref) {
      useImperativeHandle(ref, () => ({ submit: submitSpy }), []);
      return <div data-testid="fake-rainforest-iframe">[rainforest iframe]</div>;
    }
  );
  return { RainforestPaymentForm: FakeForm };
});

const baseSetup = {
  session_key: "sess_test",
  payment_method_config_id: "pmc_test",
  allowed_methods: "CARD,ACH",
};

const basePlan = {
  id: "pln-test",
  name: "Her Membership",
  amount_cents: 9900,
  interval: "month",
};

const mockSubmitSpy = vi.fn();

function Harness({
  agreementAccepted = false,
  attaching = false,
  error = "",
  iframeLoaded = true,
  cardValid = true,
  mockMode = false,
}: {
  agreementAccepted?: boolean;
  attaching?: boolean;
  error?: string;
  iframeLoaded?: boolean;
  cardValid?: boolean;
  mockMode?: boolean;
}) {
  const ref = useRef<RainforestPaymentFormHandle>(null);
  return (
    <PaymentStep
      plan={basePlan}
      mockMode={mockMode}
      setup={mockMode ? null : baseSetup}
      bundle={mockMode ? "" : "https://static.rainforestpay.com/sandbox.payment.js"}
      attaching={attaching}
      error={error}
      setError={vi.fn()}
      agreementAccepted={agreementAccepted}
      onAgreementChange={vi.fn()}
      paymentSetupLoading={false}
      paymentFormRef={ref}
      iframeLoaded={iframeLoaded}
      cardValid={cardValid}
      onApproved={vi.fn()}
      onMockSubmit={mockSubmitSpy}
      onDeclined={vi.fn()}
      onError={vi.fn()}
      onLoaded={vi.fn()}
      onValidityChange={vi.fn()}
      onAttempted={vi.fn()}
      onRetry={vi.fn()}
      onBack={vi.fn()}
      formatPrice={(cents, interval) =>
        `$${(cents / 100).toFixed(2)}/${interval === "month" ? "mo" : "yr"}`
      }
    />
  );
}

beforeEach(() => {
  submitSpy.mockReset();
  mockSubmitSpy.mockReset();
});

describe("PaymentStep", () => {
  it("renders the iframe placeholder and the purple-pill CTA", () => {
    render(<Harness />);
    expect(screen.getByTestId("fake-rainforest-iframe")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Save card & continue/i })
    ).toBeInTheDocument();
  });

  it("disables the CTA until the agreement is checked", () => {
    render(<Harness agreementAccepted={false} />);
    const cta = screen.getByRole("button", { name: /Save card & continue/i });
    expect(cta).toBeDisabled();
  });

  it("enables the CTA once the agreement is checked", () => {
    render(<Harness agreementAccepted={true} />);
    const cta = screen.getByRole("button", { name: /Save card & continue/i });
    expect(cta).toBeEnabled();
  });

  it("invokes paymentFormRef.submit() when the CTA is clicked", () => {
    render(<Harness agreementAccepted={true} />);
    const cta = screen.getByRole("button", { name: /Save card & continue/i });
    fireEvent.click(cta);
    expect(submitSpy).toHaveBeenCalledTimes(1);
  });

  it("does not call submit() while disabled (no agreement)", () => {
    render(<Harness agreementAccepted={false} />);
    const cta = screen.getByRole("button", { name: /Save card & continue/i });
    fireEvent.click(cta);
    expect(submitSpy).not.toHaveBeenCalled();
  });

  it("disables the CTA and shows the spinner + Saving… label while attaching", () => {
    render(<Harness agreementAccepted={true} attaching={true} />);
    const cta = screen.getByRole("button", { name: /Saving…/i });
    expect(cta).toBeDisabled();
  });

  it("disables the CTA while the iframe hasn't fired `loaded`", () => {
    render(<Harness agreementAccepted={true} iframeLoaded={false} />);
    const cta = screen.getByRole("button", { name: /Save card & continue/i });
    expect(cta).toBeDisabled();
    expect(screen.getByText(/Loading secure payment form/i)).toBeInTheDocument();
  });

  it("disables the CTA while the card form is invalid", () => {
    render(
      <Harness
        agreementAccepted={true}
        iframeLoaded={true}
        cardValid={false}
      />
    );
    const cta = screen.getByRole("button", { name: /Save card & continue/i });
    expect(cta).toBeDisabled();
    expect(
      screen.getByText(/Complete your card details to continue/i)
    ).toBeInTheDocument();
  });

  describe("mock mode (non-prod)", () => {
    it("hides the Rainforest iframe and shows a sandbox notice", () => {
      render(<Harness mockMode={true} />);
      expect(
        screen.queryByTestId("fake-rainforest-iframe")
      ).not.toBeInTheDocument();
      expect(screen.getByTestId("payment-mock-notice")).toBeInTheDocument();
    });

    it("ignores iframe/card gating — only the agreement gates the CTA", () => {
      render(
        <Harness
          mockMode={true}
          agreementAccepted={false}
          iframeLoaded={false}
          cardValid={false}
        />
      );
      const cta = screen.getByRole("button", {
        name: /Save card & continue/i,
      });
      expect(cta).toBeDisabled();
    });

    it("enables the CTA in mock mode with only the agreement checked", () => {
      render(
        <Harness
          mockMode={true}
          agreementAccepted={true}
          iframeLoaded={false}
          cardValid={false}
        />
      );
      expect(
        screen.getByRole("button", { name: /Save card & continue/i })
      ).toBeEnabled();
    });

    it("invokes onMockSubmit (NOT the iframe submit) when clicked", () => {
      render(<Harness mockMode={true} agreementAccepted={true} />);
      fireEvent.click(
        screen.getByRole("button", { name: /Save card & continue/i })
      );
      expect(mockSubmitSpy).toHaveBeenCalledTimes(1);
      expect(submitSpy).not.toHaveBeenCalled();
    });
  });

  it("renders the agreement checkbox AFTER the iframe in DOM order", () => {
    const { container } = render(<Harness />);
    const iframe = container.querySelector(
      "[data-testid='fake-rainforest-iframe']"
    );
    const checkbox = container.querySelector("#membership-agreement");
    expect(iframe).toBeTruthy();
    expect(checkbox).toBeTruthy();
    if (iframe && checkbox) {
      expect(
        iframe.compareDocumentPosition(checkbox) &
        Node.DOCUMENT_POSITION_FOLLOWING
      ).toBeTruthy();
    }
  });
});
