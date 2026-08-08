import { NextRequest, NextResponse } from "next/server";
import { captureServerException, captureServerMessage } from "@/lib/capture-exception";
import {
  enhancedBestMatch,
  getOpenAppointments,
  bookAppointment,
  getPatientAppointments,
} from "@/lib/athena/client";
import {
  shouldEnforceRetellSignature,
  verifyRetellSignature,
} from "@/lib/retell/verify";
import type {
  RetellToolRequest,
  RetellToolResponse,
  LookupPatientArgs,
  AvailableSlotsArgs,
  BookAppointmentArgs,
  CurrentAppointmentsArgs,
} from "@/lib/retell/types";

/**
 * Retell custom tool handler for the established-patient SchedulingWizard
 * voice/SMS agent. Distinct from /api/portal/retell/registration-tools
 * (which serves Dot's new-patient flow).
 *
 * Retell sends signed POSTs whose body is HMAC-SHA256-hex'd with the
 * Retell API key (X-Retell-Signature). We verify in production; preview
 * deploys accept unsigned bodies for engineering iteration.
 */
export async function POST(request: NextRequest) {
  const rawBody = await request.text();

  const verification = verifyRetellSignature(rawBody, request.headers);
  if (!verification.ok && shouldEnforceRetellSignature()) {
    captureServerMessage("Retell tool call: invalid signature", {
      level: "warning",
      extra: { reason: verification.reason },
    });
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  try {
    const toolRequest: RetellToolRequest = rawBody
      ? (JSON.parse(rawBody) as RetellToolRequest)
      : ({ name: "", arguments: {}, tool_call_id: "" } as RetellToolRequest);
    const { name, arguments: args, tool_call_id } = toolRequest;

    let result: string;

    switch (name) {
      case "lookup_patient":
        result = await handleLookupPatient(args as unknown as LookupPatientArgs);
        break;
      case "available_slots":
        result = await handleAvailableSlots(args as unknown as AvailableSlotsArgs);
        break;
      case "book_appointment":
        result = await handleBookAppointment(args as unknown as BookAppointmentArgs);
        break;
      case "current_appointments":
        result = await handleCurrentAppointments(args as unknown as CurrentAppointmentsArgs);
        break;
      default:
        result = JSON.stringify({ error: `Unknown tool: ${name}` });
    }

    const response: RetellToolResponse = { tool_call_id, result };
    return NextResponse.json(response);
  } catch (err) {
    console.error("[Retell Tools] Error:", err);
    captureServerException(err, { tags: { route: "retell/tools" } });
    return NextResponse.json(
      { tool_call_id: "error", result: JSON.stringify({ error: "Tool execution failed" }) },
      { status: 200 }
    );
  }
}

async function handleLookupPatient(args: LookupPatientArgs): Promise<string> {
  try {
    const patients = await enhancedBestMatch({
      firstname: args.first_name,
      lastname: args.last_name,
      dob: args.date_of_birth,
      mobilephone: args.phone,
    });

    if (!patients || patients.length === 0) {
      return JSON.stringify({
        found: false,
        message: "No patient found with that information.",
      });
    }

    const patient = patients[0];
    return JSON.stringify({
      found: true,
      patient_id: patient.patientid,
      name: `${patient.firstname} ${patient.lastname}`,
      dob: patient.dob,
    });
  } catch {
    return JSON.stringify({ found: false, message: "Unable to look up patient at this time." });
  }
}

async function handleAvailableSlots(args: AvailableSlotsArgs): Promise<string> {
  try {
    const departmentId = args.department_id ? Number(args.department_id) : 1;
    const slots = await getOpenAppointments({
      departmentid: departmentId,
      providerid: args.provider_id ? Number(args.provider_id) : undefined,
      appointmenttypeid: args.appointment_type ? Number(args.appointment_type) : undefined,
      startdate: args.date_from,
      enddate: args.date_to,
    });

    if (!slots || slots.length === 0) {
      return JSON.stringify({
        available: false,
        message: "No available slots found for the requested dates.",
      });
    }

    const formatted = slots.slice(0, 5).map((s) => ({
      appointment_id: s.appointmentid,
      date: s.date,
      time: s.starttime,
      provider: s.providerfullname,
      department_id: s.departmentid,
      appointment_type_id: s.appointmenttypeid,
    }));

    return JSON.stringify({
      available: true,
      slots: formatted,
      total: slots.length,
      showing: formatted.length,
    });
  } catch {
    return JSON.stringify({ available: false, message: "Unable to check availability right now." });
  }
}

async function handleBookAppointment(args: BookAppointmentArgs): Promise<string> {
  try {
    // Athena's `PUT /appointments/{appointmentid}` keys on the *slot id*
    // returned by /appointments/open (which we surface to the LLM as
    // `appointment_id`), not the appointment-type id. The previous
    // implementation passed `appointment_type_id` for both, which made
    // every booking 400 with "Appointment not found". Fix: send the slot
    // id in the path and the type id only in the body so Athena rewrites
    // the slot's type to the visit reason.
    const slotId = Number(args.appointment_id);
    if (!Number.isFinite(slotId)) {
      return JSON.stringify({
        booked: false,
        message: "Missing appointment_id (the slot id from available_slots).",
      });
    }
    const apptTypeId = args.appointment_type_id
      ? Number(args.appointment_type_id)
      : undefined;
    const departmentId = args.department_id ? Number(args.department_id) : undefined;

    const result = await bookAppointment({
      appointmentId: slotId,
      patientId: Number(args.patient_id),
      departmentid: departmentId,
      appointmenttypeid: apptTypeId,
      bookingnote: args.reason,
    });

    return JSON.stringify({
      booked: true,
      appointment_id: result.appointmentid,
      message: `Appointment booked for ${args.date} at ${args.time}.`,
    });
  } catch (err) {
    captureServerException(err, {
      tags: { route: "retell/tools", tool: "book_appointment" },
    });
    return JSON.stringify({ booked: false, message: "Unable to book the appointment. Please try again." });
  }
}

async function handleCurrentAppointments(args: CurrentAppointmentsArgs): Promise<string> {
  try {
    const appointments = await getPatientAppointments(args.patient_id);

    if (!appointments || appointments.length === 0) {
      return JSON.stringify({
        has_appointments: false,
        message: "No upcoming appointments found.",
      });
    }

    const formatted = appointments.slice(0, 5).map((a) => ({
      appointment_id: a.appointmentid,
      date: a.date,
      time: a.starttime,
      provider: a.providerfullname,
      status: a.appointmentstatus,
      type: a.appointmenttype,
    }));

    return JSON.stringify({
      has_appointments: true,
      appointments: formatted,
      total: appointments.length,
    });
  } catch {
    return JSON.stringify({ has_appointments: false, message: "Unable to retrieve appointments." });
  }
}
