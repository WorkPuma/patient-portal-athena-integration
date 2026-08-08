/**
 * Carrier brand marks for the eligibility brand picker.
 *
 * When an official logo asset exists in `/images/insurance/<brandId>.png`, we
 * render it inside a rounded container sized to the `size` prop. For brands
 * without a sourced logo (government programs, catch-all) we fall back to an
 * inline SVG monogram badge in the carrier's primary brand colour.
 *
 * Keys mirror `PortalPayerBrand.brandId` from `lib/stedi/brand-resolver`.
 */

import Image from "next/image";
import {
  HelpCircle,
  Shield,
  Star,
} from "lucide-react";

// ── Official logo paths (sourced from carrier brand assets) ──────────
// Only brands with a verified official logo are listed here. The rest
// fall through to the monogram renderer below.
const BRAND_LOGO_PATHS: Record<string, string> = {
  bcbs: "/images/insurance/bcbs.png",
  uhc: "/images/insurance/uhc.png",
  ucare: "/images/insurance/ucare.png",
  aetna: "/images/insurance/aetna.png",
  medica: "/images/insurance/medica.png",
  healthpartners: "/images/insurance/healthpartners.png",
  humana: "/images/insurance/humana.png",
};

// ── Monogram fallback specs ──────────────────────────────────────────
interface BrandMarkSpec {
  monogram: string;
  bg: string;
  fg: string;
  accent?: string;
}

const BRAND_MARKS: Record<string, BrandMarkSpec> = {
  medicare: { monogram: "M", bg: "#1A3A66", fg: "#FFFFFF", accent: "#D52B1E" },
  tricare: { monogram: "T", bg: "#1A3A66", fg: "#FFFFFF", accent: "#D52B1E" },
  "tricare-for-life": {
    monogram: "TFL",
    bg: "#1A3A66",
    fg: "#FFFFFF",
    accent: "#D52B1E",
  },
  "medicaid-mn": { monogram: "M+", bg: "#0E5077", fg: "#FFFFFF" },
  "va-champva": { monogram: "VA", bg: "#112E51", fg: "#FFFFFF" },
};

interface InsuranceLogoProps {
  brandId: string;
  size?: number;
  className?: string;
}

/**
 * Render the carrier badge for a brand. Uses official logo assets when
 * available; falls back to a coloured monogram badge for government
 * programs and the "Other" / unknown brand.
 */
export function InsuranceLogo({
  brandId,
  size = 40,
  className,
}: InsuranceLogoProps) {
  const logoPath = BRAND_LOGO_PATHS[brandId];

  // ── Official logo ──────────────────────────────────────────────────
  if (logoPath) {
    return (
      <span
        className={className}
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: size,
          height: size,
          borderRadius: 8,
          overflow: "hidden",
          flexShrink: 0,
        }}
        aria-hidden="true"
      >
        <Image
          src={logoPath}
          alt=""
          width={size}
          height={size}
          style={{
            width: size,
            height: size,
            objectFit: "cover",
          }}
          unoptimized
        />
      </span>
    );
  }

  // ── Monogram fallback ──────────────────────────────────────────────
  const spec = BRAND_MARKS[brandId];

  if (!spec) {
    return (
      <span
        className={className}
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: size,
          height: size,
          borderRadius: 8,
          background: "#F3F0EA",
          color: "#6B7280",
        }}
        aria-hidden="true"
      >
        <HelpCircle style={{ width: size * 0.55, height: size * 0.55 }} />
      </span>
    );
  }

  const fontSize = Math.round(
    size * (spec.monogram.length >= 3 ? 0.32 : spec.monogram.length === 2 ? 0.4 : 0.5)
  );

  return (
    <span
      className={className}
      style={{
        position: "relative",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: size,
        height: size,
        borderRadius: 8,
        background: spec.bg,
        color: spec.fg,
        fontFamily:
          "ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
        fontWeight: 700,
        fontSize,
        lineHeight: 1,
        letterSpacing: "-0.02em",
      }}
      aria-hidden="true"
    >
      {spec.monogram}
      {spec.accent && (
        <Star
          fill={spec.accent}
          stroke={spec.accent}
          style={{
            position: "absolute",
            right: Math.max(2, size * 0.08),
            bottom: Math.max(2, size * 0.08),
            width: size * 0.28,
            height: size * 0.28,
          }}
        />
      )}
    </span>
  );
}

/** Used at small sizes (16-20px) where the monogram becomes illegible. */
export function InsuranceLogoMini({
  brandId,
  className,
}: {
  brandId: string;
  className?: string;
}) {
  const spec = BRAND_MARKS[brandId];
  if (!spec && !BRAND_LOGO_PATHS[brandId]) {
    return <HelpCircle className={className} aria-hidden="true" />;
  }
  const color = spec?.bg ?? "#005A9C";
  return (
    <Shield
      className={className}
      style={{ color }}
      fill={color}
      aria-hidden="true"
    />
  );
}
