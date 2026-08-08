"use client";

/**
 * RainforestPaymentForm
 *
 * Renders Rainforest's `<rainforest-payment>` web component to collect a card
 * or ACH payment method directly inside our wizard. The component handles all
 * PCI-sensitive input — we only ever see the resulting `payment_method_id`
 * (a Rainforest token) which we forward to Hint.
 *
 * Wiring:
 *   1. Caller fetches /api/portal/register/membership/payment-setup, which
 *      returns { setup, bundle, hintPatientId }.
 *   2. Pass `setup` and `bundle` here as props.
 *   3. We dynamically inject the bundle <script> once per page.
 *   4. We mount the web component and listen for `approved` / `declined` /
 *      `error` events.
 *   5. On `approved`, we hand the `payment_method_id` (= rainforest_id) back
 *      to the caller via `onApproved`.
 *
 * Reference:
 *   - https://docs.rainforestpay.com/docs/store-payment-methods-via-component
 */

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";

// Rainforest's web component is a custom HTML element; let TS know it's OK to
// render <rainforest-payment …> from JSX. We deliberately keep this loose
// because the Rainforest API surface is documented externally and may grow.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace JSX {
    interface IntrinsicElements {
      "rainforest-payment": React.DetailedHTMLProps<
        React.HTMLAttributes<HTMLElement> & {
          "session-key"?: string;
          "payment-method-config-id"?: string;
          "allowed-methods"?: string;
          "hide-button"?: boolean | "";
        },
        HTMLElement
      >;
    }
  }
}

// Minimal shape of the live `<rainforest-payment>` element we interact with.
// Rainforest exposes an imperative `submit()` method for the "hide-button"
// integration pattern — see
// https://docs.rainforestpay.com/docs/hide-the-submit-button
interface RainforestElement extends HTMLElement {
  submit?: () => void;
}

/**
 * Imperative handle exposed to parents so they can drive the iframe's
 * submission from their own CTA (instead of Rainforest's inline "Store
 * details" button). Calling `submit()` is a no-op until the iframe has
 * mounted AND emitted at least one `valid` event.
 */
export interface RainforestPaymentFormHandle {
  submit: () => void;
}

export interface RainforestSetup {
  payment_method_config_id: string;
  session_key: string;
  allowed_methods: string;
}

export interface RainforestApprovedDetail {
  payment_method_id: string;
  [k: string]: unknown;
}

interface Props {
  setup: RainforestSetup;
  bundle: string;
  onApproved: (rainforestId: string, raw: RainforestApprovedDetail) => void;
  onDeclined?: (detail: unknown) => void;
  onError?: (detail: unknown) => void;
  /** Show our own loading skeleton until Rainforest's `loaded` event fires. */
  onLoaded?: () => void;
  /**
   * Fired whenever the iframe transitions between `valid` and `invalid`. The
   * parent uses this to enable/disable its own submit CTA when running in
   * `hideInlineButton` mode.
   */
  onValidityChange?: (isValid: boolean) => void;
  /**
   * Fired immediately after a successful `submit()` — i.e. Rainforest has
   * accepted the click and is now contacting their backend. Use this to
   * flip your CTA into a "Saving…" spinner state so the button doesn't
   * look idle during the round-trip.
   */
  onAttempted?: () => void;
  /**
   * Hide Rainforest's built-in "Store details" button so the parent can drive
   * submission from its own CTA via the imperative `submit()` handle.
   */
  hideInlineButton?: boolean;
}

const SCRIPT_ATTR = "data-rainforest-bundle";

function ensureBundleLoaded(bundle: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (typeof window === "undefined") {
      resolve();
      return;
    }
    const existing = document.querySelector<HTMLScriptElement>(
      `script[${SCRIPT_ATTR}="${bundle}"]`
    );
    if (existing) {
      if (existing.dataset.loaded === "true") {
        resolve();
        return;
      }
      existing.addEventListener("load", () => resolve());
      existing.addEventListener("error", () =>
        reject(new Error("Failed to load Rainforest bundle"))
      );
      return;
    }
    const tag = document.createElement("script");
    tag.type = "module";
    tag.src = bundle;
    tag.setAttribute(SCRIPT_ATTR, bundle);
    tag.addEventListener("load", () => {
      tag.dataset.loaded = "true";
      resolve();
    });
    tag.addEventListener("error", () =>
      reject(new Error("Failed to load Rainforest bundle"))
    );
    document.head.appendChild(tag);
  });
}

export const RainforestPaymentForm = forwardRef<
  RainforestPaymentFormHandle,
  Props
>(function RainforestPaymentForm(
  {
    setup,
    bundle,
    onApproved,
    onDeclined,
    onError,
    onLoaded,
    onValidityChange,
    onAttempted,
    hideInlineButton = false,
  },
  forwardedRef
) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const elementRef = useRef<RainforestElement | null>(null);
  const [bundleError, setBundleError] = useState<string>("");

  // Keep the latest callbacks in refs so the mount effect below depends ONLY
  // on the (stable) Rainforest session/config — re-mounting the iframe when
  // parent state changes is destructive: a Rainforest payment_method_config_id
  // can only be associated to ONE successful payment, so re-attaching after
  // the user has already clicked "Store details" locks the button and drops
  // the click that just succeeded. The ref pattern lets the parent re-render
  // freely while the iframe stays put.
  const onApprovedRef = useRef(onApproved);
  const onDeclinedRef = useRef(onDeclined);
  const onErrorRef = useRef(onError);
  const onLoadedRef = useRef(onLoaded);
  const onValidityChangeRef = useRef(onValidityChange);
  const onAttemptedRef = useRef(onAttempted);
  useEffect(() => {
    onApprovedRef.current = onApproved;
  }, [onApproved]);
  useEffect(() => {
    onDeclinedRef.current = onDeclined;
  }, [onDeclined]);
  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);
  useEffect(() => {
    onLoadedRef.current = onLoaded;
  }, [onLoaded]);
  useEffect(() => {
    onValidityChangeRef.current = onValidityChange;
  }, [onValidityChange]);
  useEffect(() => {
    onAttemptedRef.current = onAttempted;
  }, [onAttempted]);

  // Imperative handle so the parent can drive submission from its own CTA
  // without re-rendering / re-mounting the iframe.
  useImperativeHandle(
    forwardedRef,
    () => ({
      submit: () => {
        const el = elementRef.current;
        if (el && typeof el.submit === "function") {
          el.submit();
        }
      },
    }),
    []
  );

  useEffect(() => {
    let cancelled = false;
    let element: RainforestElement | null = null;

    const handleApproved = (e: Event) => {
      const detail = (e as CustomEvent<RainforestApprovedDetail>).detail;
      const id =
        (detail && typeof detail.payment_method_id === "string"
          ? detail.payment_method_id
          : undefined) ?? "";
      if (id) onApprovedRef.current(id, detail);
    };
    const handleDeclined = (e: Event) =>
      onDeclinedRef.current?.((e as CustomEvent).detail);
    const handleError = (e: Event) =>
      onErrorRef.current?.((e as CustomEvent).detail);
    const handleLoaded = () => onLoadedRef.current?.();
    const handleValid = () => onValidityChangeRef.current?.(true);
    const handleInvalid = () => onValidityChangeRef.current?.(false);
    const handleAttempted = () => onAttemptedRef.current?.();

    (async () => {
      try {
        await ensureBundleLoaded(bundle);
      } catch (err) {
        if (!cancelled) {
          setBundleError(
            err instanceof Error
              ? err.message
              : "Failed to load payment form. Please refresh and try again."
          );
        }
        return;
      }
      if (cancelled || !containerRef.current) return;

      element = document.createElement(
        "rainforest-payment"
      ) as RainforestElement;
      element.setAttribute("session-key", setup.session_key);
      element.setAttribute(
        "payment-method-config-id",
        setup.payment_method_config_id
      );
      element.setAttribute("allowed-methods", setup.allowed_methods);
      if (hideInlineButton) {
        // Boolean attribute — Rainforest only checks for presence, so the
        // value we pass is irrelevant.
        element.setAttribute("hide-button", "");
      }
      element.addEventListener("approved", handleApproved);
      element.addEventListener("declined", handleDeclined);
      element.addEventListener("error", handleError);
      element.addEventListener("loaded", handleLoaded);
      element.addEventListener("valid", handleValid);
      element.addEventListener("invalid", handleInvalid);
      element.addEventListener("attempted", handleAttempted);
      containerRef.current.appendChild(element);
      elementRef.current = element;
    })();

    return () => {
      cancelled = true;
      if (element) {
        element.removeEventListener("approved", handleApproved);
        element.removeEventListener("declined", handleDeclined);
        element.removeEventListener("error", handleError);
        element.removeEventListener("loaded", handleLoaded);
        element.removeEventListener("valid", handleValid);
        element.removeEventListener("invalid", handleInvalid);
        element.removeEventListener("attempted", handleAttempted);
        element.remove();
      }
      elementRef.current = null;
    };
    // Intentionally only depends on the bundle + session identifiers — see
    // the ref dance above for why the callbacks are excluded. `hideInlineButton`
    // also goes here because flipping it requires re-rendering the iframe.
  }, [
    bundle,
    setup.session_key,
    setup.payment_method_config_id,
    setup.allowed_methods,
    hideInlineButton,
  ]);

  if (bundleError) {
    return (
      <div className="rounded-xl border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">
        {bundleError}
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="min-h-[280px] rounded-2xl border border-border bg-card p-2"
    />
  );
});
