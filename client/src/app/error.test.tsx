import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

/* Error boundaries report the caught render error once (AC-35). */

const monitoring = vi.hoisted(() => ({ reportRenderError: vi.fn() }));
vi.mock("@/lib/monitoring", () => monitoring);

import RouteError from "./error";
import GlobalError from "./global-error";

beforeEach(() => {
  monitoring.reportRenderError.mockClear();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("error boundaries", () => {
  it("RouteError reports the error once and retries on demand", async () => {
    const user = userEvent.setup();
    const reset = vi.fn();
    const error = new Error("render exploded");

    render(<RouteError error={error} reset={reset} />);

    expect(screen.getByText("Something went wrong")).toBeInTheDocument();
    expect(monitoring.reportRenderError).toHaveBeenCalledTimes(1);
    expect(monitoring.reportRenderError).toHaveBeenCalledWith(error);

    await user.click(screen.getByRole("button", { name: /retry|try again/i }));
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it("GlobalError reports the error once", () => {
    const error = Object.assign(new Error("layout exploded"), { digest: "d1" });

    render(<GlobalError error={error} reset={() => {}} />);

    expect(screen.getByText("DevDigest crashed")).toBeInTheDocument();
    expect(monitoring.reportRenderError).toHaveBeenCalledTimes(1);
    expect(monitoring.reportRenderError).toHaveBeenCalledWith(error);
  });
});
