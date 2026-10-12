import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AdminCompanies } from "./admin-companies";
import { AdminUsers } from "./admin-users";

/**
 * Admin onboarding screen unit tests (Requirements 1.3-1.7, 15.2, 16.1).
 *
 * Every control is found by its accessible label rather than by a test id, so
 * these also stand as the accessibility check the design asks for: a control
 * that loses its label fails here. Server rejections are asserted through
 * `role="alert"`, which is how a field user is told what went wrong.
 *
 * The only stand-in is `fetch` — the process boundary. The components, the
 * api-client, and the error shape they read are all real.
 */

const ROSTER = {
  buyers: [
    {
      id: "co-buyer-1",
      name: "SW Valley Concrete",
      kind: "buyer",
      supplierApprovalStatus: null,
      supplierStatus: null,
      operatingLat: null,
      operatingLng: null,
      serviceRadiusMiles: null,
    },
  ],
  suppliers: [
    {
      id: "co-supplier-1",
      name: "Buckeye Diesel",
      kind: "supplier",
      supplierApprovalStatus: "pending",
      supplierStatus: "closed",
      operatingLat: null,
      operatingLng: null,
      serviceRadiusMiles: null,
    },
  ],
};

interface Call {
  path: string;
  method: string;
  body: unknown;
}

/** A fetch that answers the roster GET and defers each write to `reply`. */
function stubFetch(
  reply: (call: Call) => { status: number; body: unknown }
): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string, init: RequestInit = {}) => {
      const method = init.method ?? "GET";
      const body =
        typeof init.body === "string" ? JSON.parse(init.body) : undefined;
      calls.push({ path, method, body });

      const answer =
        method === "GET"
          ? { status: 200, body: ROSTER }
          : reply({ path, method, body });

      return new Response(JSON.stringify(answer.body), {
        status: answer.status,
        headers: { "Content-Type": "application/json" },
      });
    })
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AdminCompanies (Requirement 16.1)", () => {
  it("posts a name and kind, and says a new supplier is pending approval", async () => {
    const calls = stubFetch(() => ({
      status: 201,
      body: {
        company: { ...ROSTER.suppliers[0], name: "Estrella Fuel" },
      },
    }));

    render(<AdminCompanies />);
    await screen.findByText("Buckeye Diesel");

    await userEvent.type(
      screen.getByLabelText("Company name"),
      "Estrella Fuel"
    );
    await userEvent.click(
      screen.getByRole("radio", { name: /Supplier/ })
    );
    await userEvent.click(screen.getByRole("button", { name: "Create company" }));

    const write = await waitFor(() => {
      const found = calls.find((call) => call.method === "POST");
      expect(found).toBeDefined();
      return found!;
    });
    expect(write.path).toBe("/api/admin/companies");
    expect(write.body).toEqual({ name: "Estrella Fuel", kind: "supplier" });

    expect((await screen.findByRole("status")).textContent).toMatch(
      /pending approval/i
    );
  });

  it("shows the server's rejection in an alert", async () => {
    stubFetch(() => ({
      status: 400,
      body: {
        error: {
          code: "COMPANY_NAME_REQUIRED",
          message: "A company name is required",
          field: "name",
        },
      },
    }));

    render(<AdminCompanies />);
    await screen.findByText("Buckeye Diesel");
    await userEvent.click(screen.getByRole("button", { name: "Create company" }));

    expect((await screen.findByRole("alert")).textContent).toContain(
      "A company name is required"
    );
  });
});

describe("AdminUsers (Requirements 1.3-1.7)", () => {
  it("offers every company and role on one form and posts the typed seat", async () => {
    const calls = stubFetch(() => ({
      status: 201,
      body: {
        user: {
          id: "user-1",
          companyId: "co-supplier-1",
          role: "supplier",
          phone: "+16025550144",
          email: null,
        },
      },
    }));

    render(<AdminUsers />);
    await screen.findByRole("option", { name: "Buckeye Diesel" });

    // Requirement 1.3 — a user belongs to exactly one company, picked here.
    await userEvent.selectOptions(
      screen.getByLabelText("Company"),
      "co-supplier-1"
    );
    // Requirement 1.4 — exactly one role.
    await userEvent.selectOptions(screen.getByLabelText("Role"), "supplier");
    // Requirements 1.5, 1.7 — phone required, email optional (left blank).
    await userEvent.type(
      screen.getByLabelText("Phone number"),
      " +16025550144 "
    );
    await userEvent.type(
      screen.getByLabelText("Temporary password"),
      "correct horse battery staple"
    );
    await userEvent.click(screen.getByRole("button", { name: "Create user" }));

    const write = await waitFor(() => {
      const found = calls.find((call) => call.method === "POST");
      expect(found).toBeDefined();
      return found!;
    });
    expect(write.path).toBe("/api/admin/users");
    expect(write.body).toEqual({
      companyId: "co-supplier-1",
      role: "supplier",
      phone: "+16025550144",
      email: null,
      password: "correct horse battery staple",
    });

    expect((await screen.findByRole("status")).textContent).toContain(
      "+16025550144"
    );
  });

  it("surfaces a malformed phone number as an alert (Requirement 1.6)", async () => {
    stubFetch(() => ({
      status: 400,
      body: {
        error: {
          code: "PHONE_INVALID",
          message: "A phone number must be in E.164 form",
          field: "phone",
        },
      },
    }));

    render(<AdminUsers />);
    await screen.findByRole("option", { name: "Buckeye Diesel" });

    await userEvent.type(screen.getByLabelText("Phone number"), "602-555-0144");
    await userEvent.click(screen.getByRole("button", { name: "Create user" }));

    expect((await screen.findByRole("alert")).textContent).toContain(
      "A phone number must be in E.164 form"
    );
  });
});
