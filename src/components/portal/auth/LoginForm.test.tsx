import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { LoginForm } from "./LoginForm";

const mockReplace = vi.fn();

let mockIsSignedIn = false;
let mockUserLoaded = true;

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: mockReplace,
    prefetch: vi.fn(),
    back: vi.fn(),
  }),
}));

vi.mock("@clerk/nextjs", () => ({
  SignIn: ({ fallbackRedirectUrl }: Record<string, string>) => (
    <div data-testid="clerk-sign-in" data-fallback={fallbackRedirectUrl}>
      Clerk SignIn Component
    </div>
  ),
  useUser: () => ({
    isSignedIn: mockIsSignedIn,
    isLoaded: mockUserLoaded,
  }),
}));

const flagsState = { dot: false, membership: true, authUi: true };
vi.mock("@/lib/portal/feature-flags", () => ({
  getClientPortalFeatureFlags: () => ({ ...flagsState }),
  getPortalFeatureFlags: () => ({ ...flagsState, passiveClerk: true }),
  getPublicPortalFeatureFlags: () => ({ ...flagsState }),
}));

describe("LoginForm", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsSignedIn = false;
    mockUserLoaded = true;
    flagsState.authUi = true;
  });

  it("shows branding", () => {
    render(<LoginForm />);
    // The brand mark is now an <Image alt="Herself Health" /> (commit
    // ff4f2bb replaced the prior <h1>Herself Health</h1>), so we match
    // the alt-text instead of body text.
    expect(screen.getByAltText("Herself Health")).toBeInTheDocument();
  });

  it("renders Clerk SignIn component", () => {
    render(<LoginForm />);
    expect(screen.getByTestId("clerk-sign-in")).toBeInTheDocument();
  });

  it("passes correct props to SignIn", () => {
    render(<LoginForm />);
    const signIn = screen.getByTestId("clerk-sign-in");
    expect(signIn).toHaveAttribute("data-fallback", "/dashboard");
  });

  it("shows registration link for new patients when authUi is on", () => {
    render(<LoginForm />);
    expect(screen.getByText("Register here")).toBeInTheDocument();
  });

  it("hides the 'Register here' link when authUi is off", () => {
    flagsState.authUi = false;
    render(<LoginForm />);
    expect(screen.queryByText("Register here")).not.toBeInTheDocument();
  });

  it("shows HIPAA notice", () => {
    render(<LoginForm />);
    expect(screen.getByText(/HIPAA/i)).toBeInTheDocument();
  });

  it("shows loading spinner when user not loaded", () => {
    mockUserLoaded = false;
    render(<LoginForm />);
    expect(screen.queryByTestId("clerk-sign-in")).not.toBeInTheDocument();
  });

  it("redirects to dashboard when already signed in", async () => {
    mockIsSignedIn = true;
    render(<LoginForm />);

    await waitFor(() => {
      expect(mockReplace).toHaveBeenCalledWith("/dashboard");
    });
  });
});
