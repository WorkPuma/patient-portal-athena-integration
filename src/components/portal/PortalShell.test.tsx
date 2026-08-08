import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { PortalShell } from "./PortalShell";

let mockPathname = "/dashboard";

vi.mock("next/navigation", () => ({
  usePathname: () => mockPathname,
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    prefetch: vi.fn(),
    back: vi.fn(),
  }),
}));

vi.mock("@clerk/nextjs", () => ({
  useClerk: () => ({ signOut: vi.fn() }),
  UserButton: () => <div data-testid="clerk-user-button" />,
}));

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

function mockSessionResponse(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    json: () =>
      Promise.resolve({
        user: {
          displayName: "Test User",
          email: "test@example.com",
          disambiguationRequired: false,
          registrationComplete: true,
          athenaPatientId: "12345",
          ...overrides,
        },
      }),
  } as unknown as Response;
}

describe("PortalShell", () => {
  beforeEach(() => {
    mockPathname = "/dashboard";
    vi.spyOn(global, "fetch").mockResolvedValue(mockSessionResponse());
  });

  describe("isPublicPath — hydration consistency", () => {
    it("renders simple layout for /login (client-side pathname)", () => {
      mockPathname = "/login";
      const { container } = render(
        <PortalShell>
          <div data-testid="child" />
        </PortalShell>
      );

      expect(screen.getByTestId("child")).toBeInTheDocument();
      expect(container.querySelector("aside")).toBeNull();
      expect(container.querySelector("nav")).toBeNull();
    });

    it("renders simple layout for /portal/login (SSR rewritten pathname)", () => {
      mockPathname = "/portal/login";
      const { container } = render(
        <PortalShell>
          <div data-testid="child" />
        </PortalShell>
      );

      expect(screen.getByTestId("child")).toBeInTheDocument();
      expect(container.querySelector("aside")).toBeNull();
    });

    it("renders simple layout for /register", () => {
      mockPathname = "/register";
      const { container } = render(
        <PortalShell>
          <div data-testid="child" />
        </PortalShell>
      );

      expect(screen.getByTestId("child")).toBeInTheDocument();
      expect(container.querySelector("aside")).toBeNull();
    });

    it("renders simple layout for /portal/register (SSR rewritten pathname)", () => {
      mockPathname = "/portal/register";
      const { container } = render(
        <PortalShell>
          <div data-testid="child" />
        </PortalShell>
      );

      expect(screen.getByTestId("child")).toBeInTheDocument();
      expect(container.querySelector("aside")).toBeNull();
    });

    it("renders simple layout for /register/eligibility (nested)", () => {
      mockPathname = "/register/eligibility";
      const { container } = render(
        <PortalShell>
          <div data-testid="child" />
        </PortalShell>
      );

      expect(screen.getByTestId("child")).toBeInTheDocument();
      expect(container.querySelector("aside")).toBeNull();
    });
  });

  describe("authenticated layout", () => {
    it("renders sidebar for /dashboard", async () => {
      mockPathname = "/dashboard";
      const { container } = render(
        <PortalShell>
          <div data-testid="child" />
        </PortalShell>
      );

      await waitFor(() => {
        expect(screen.getByTestId("child")).toBeInTheDocument();
        expect(container.querySelector("aside")).not.toBeNull();
      });
    });

    it("renders sidebar for /appointments", async () => {
      mockPathname = "/appointments";
      render(
        <PortalShell>
          <div data-testid="child" />
        </PortalShell>
      );

      await waitFor(() => {
        expect(
          screen.getByRole("link", { name: /appointments/i })
        ).toBeInTheDocument();
        expect(
          screen.getByRole("link", { name: /dashboard/i })
        ).toBeInTheDocument();
      });
    });

    it("renders sidebar for /portal/dashboard (SSR rewritten)", async () => {
      mockPathname = "/portal/dashboard";
      const { container } = render(
        <PortalShell>
          <div data-testid="child" />
        </PortalShell>
      );

      await waitFor(() => {
        expect(container.querySelector("aside")).not.toBeNull();
      });
    });

    it("renders nav items with correct hrefs", async () => {
      mockPathname = "/dashboard";
      render(
        <PortalShell>
          <div />
        </PortalShell>
      );

      await waitFor(() => {
        expect(screen.getByRole("link", { name: /dashboard/i })).toHaveAttribute(
          "href",
          "/dashboard"
        );
        expect(
          screen.getByRole("link", { name: /appointments/i })
        ).toHaveAttribute("href", "/appointments");
        expect(
          screen.getByRole("link", { name: /membership/i })
        ).toHaveAttribute("href", "/membership");
        expect(screen.getByRole("link", { name: /messages/i })).toHaveAttribute(
          "href",
          "/messages"
        );
      });
    });

    it("renders sign out button", async () => {
      mockPathname = "/dashboard";
      render(
        <PortalShell>
          <div />
        </PortalShell>
      );

      await waitFor(() => {
        expect(
          screen.getByRole("button", { name: /sign out/i })
        ).toBeInTheDocument();
      });
    });

    it("renders UserButton from Clerk", async () => {
      mockPathname = "/dashboard";
      render(
        <PortalShell>
          <div />
        </PortalShell>
      );

      await waitFor(() => {
        expect(screen.getByTestId("clerk-user-button")).toBeInTheDocument();
      });
    });
  });
});
