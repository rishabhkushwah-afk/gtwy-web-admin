"use client";

import * as React from "react";
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { getPlanChoices, type PlanChoice } from "@/mocks";

type Props = { open: boolean; onOpenChange: (open: boolean) => void };

/**
 * The dialogs. Open/close works and the disabled rules match the design;
 * nothing submits.
 *
 * `InviteAdminDialog` was removed with the Invite admin control it belonged to
 * (plan §6, D9): admin access is membership of the admin msg91 project, so
 * there is nothing for an invite to write to. `LoginAsDialog` went the same way
 * with D3, the last page that opened it — plan §6 names the dialog itself, not
 * just the buttons, among the controls the board removed.
 *
 * The two enforcement dialogs — block and unblock — **do** submit, because plan
 * §6 marks those controls Live. They are the only ones. Each takes an optional
 * `onConfirm`; a page that has not wired it keeps the original behaviour, where
 * the primary button does nothing.
 */

/**
 * In-flight and failed state for a dialog whose primary button performs a live
 * action (plan §3).
 *
 * The rendered markup does not grow: a refusal replaces the dialog's own
 * explanation in the `body` slot that is already there, and "in flight" is the
 * existing `disabled` rule. Nothing is added to the design and nothing is
 * restyled.
 */
function useConfirmAction(open: boolean) {
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // A reopened dialog starts clean; a stale refusal from last time would read as
  // if this attempt had already failed.
  React.useEffect(() => {
    if (open) setError(null);
  }, [open]);

  const run = React.useCallback(async (action: () => Promise<void>) => {
    setPending(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      // `AdminFetchError` carries gtwy-node's own operator copy — "org 123 has
      // no Lago wallet — provision it first" — which is the useful thing to
      // show. 401 and 403 never reach here; `data/client.ts` handles them.
      setError(err instanceof Error ? err.message : "The action could not be completed.");
    } finally {
      setPending(false);
    }
  }, []);

  return { pending, error, run };
}

export function BlockOrgDialog({
  open,
  onOpenChange,
  orgName,
  orgId: fixedOrgId,
  needsPick = true,
  onConfirm,
}: Props & {
  orgName?: string;
  /** Known up front on a page that already has an org in hand. */
  orgId?: string;
  needsPick?: boolean;
  /** Absent on a page that has not wired the action yet — the button then does nothing, as before. */
  onConfirm?: (input: { orgId: string; reason: string }) => Promise<unknown>;
}) {
  const [orgId, setOrgId] = React.useState("");
  const [reason, setReason] = React.useState("");
  const { pending, error, run } = useConfirmAction(open);
  const id = needsPick ? orgId : (fixedOrgId ?? "set");
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Block organisation"
      body={
        /* Once the action has been refused, gtwy-node's own message is the
           thing worth reading, so it takes the slot the explanation had. */
        error ?? (
          <>
            Every request from{" "}
            <strong>{orgName ?? (orgId ? `org ${orgId}` : "this organisation")}</strong>{" "}
            will be rejected at the auth middleware until unblocked.
          </>
        )
      }
      actions={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!id || reason.trim().length < 3 || pending}
            onClick={() =>
              run(async () => {
                await onConfirm?.({ orgId: needsPick ? orgId.trim() : (fixedOrgId ?? ""), reason: reason.trim() });
                setOrgId("");
                setReason("");
                onOpenChange(false);
              })
            }
          >
            Block org
          </Button>
        </>
      }
    >
      {needsPick ? (
        <Field label="org_id">
          <Input
            placeholder="74145"
            value={orgId}
            onChange={(e) => setOrgId(e.target.value)}
          />
        </Field>
      ) : null}
      <Field label="Reason">
        <Textarea
          placeholder="Abuse / non-payment / legal hold"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
      </Field>
    </Dialog>
  );
}

/**
 * The confirmation for the other half of the same control (plan §6: "Blocked
 * page: Unblock; detail: Block/Unblock org — **Live**").
 *
 * Built from `BlockOrgDialog` directly above: same `Dialog` shell, same button
 * variants, same copy voice. No new design and no new styles — the one
 * difference is that it collects no reason, because `unblockOrg` takes none
 * (`blockedOrg.routes.js` validates the org id only) and plan §3.1 makes
 * `reason` optional for this action. With no field to fill it needs no
 * `children`, which is why the shell renders one element fewer.
 */
export function UnblockOrgDialog({
  open,
  onOpenChange,
  orgId,
  orgName,
  onConfirm,
}: Props & {
  orgId?: string;
  orgName?: string;
  onConfirm?: (input: { orgId: string }) => Promise<unknown>;
}) {
  const { pending, error, run } = useConfirmAction(open);
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Unblock organisation"
      body={
        error ?? (
          <>
            <strong>{orgName ?? (orgId ? `org ${orgId}` : "This organisation")}</strong>{" "}
            starts serving traffic again immediately. The block is removed from
            the gateway cache as well as the database.
          </>
        )
      }
      actions={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!orgId || pending}
            onClick={() =>
              run(async () => {
                await onConfirm?.({ orgId: orgId ?? "" });
                onOpenChange(false);
              })
            }
          >
            Unblock org
          </Button>
        </>
      }
    />
  );
}

/**
 * The confirmation behind the Workspace detail page's internal-org control
 * (plan §5 item 11, §9 gap 12).
 *
 * Built from `UnblockOrgDialog` directly above — same `Dialog` shell, same
 * button variants, same `useConfirmAction`, no field and so no `children`. Plan
 * §5/03 says the control sits "behind a confirmation dialog built from the
 * existing `BlockOrgDialog` pattern", which is exactly what this is; nothing is
 * designed here.
 *
 * gtwy-node's two refusals reach the operator verbatim through the same `body`
 * slot the other two use: an org msg91 does not know is its 404, and an org
 * with no Lago wallet is its 400.
 */
export function InternalOrgDialog({
  open,
  onOpenChange,
  orgId,
  orgName,
  internal,
  onConfirm,
}: Props & {
  orgId?: string;
  orgName?: string;
  /** Whether the org is on the list now — this decides which way the action goes. */
  internal: boolean;
  onConfirm?: (input: { orgId: string }) => Promise<unknown>;
}) {
  const { pending, error, run } = useConfirmAction(open);
  const who = orgName ?? (orgId ? `org ${orgId}` : "This organisation");
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={internal ? "Remove from internal orgs" : "Add to internal orgs"}
      body={
        error ??
        (internal ? (
          <>
            <strong>{who}</strong> stops being an org we run ourselves. Its plan,
            wallet and billing do not change; the internal credits dashboard can
            no longer grant it credits.
          </>
        ) : (
          <>
            <strong>{who}</strong> is recorded as an org we run ourselves, which
            is what lets the internal credits dashboard grant it credits. Its
            plan, wallet and billing are unaffected.
          </>
        ))
      }
      actions={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!orgId || pending}
            onClick={() =>
              run(async () => {
                await onConfirm?.({ orgId: orgId ?? "" });
                onOpenChange(false);
              })
            }
          >
            {internal ? "Remove from internal orgs" : "Add to internal orgs"}
          </Button>
        </>
      }
    />
  );
}

export function ChangePlanDialog({
  open,
  onOpenChange,
  wsName,
  currentPlan,
}: Props & { wsName: string; currentPlan: string }) {
  // `getPlanChoices` went live with D7 and is async now; the same conversion
  // every page got (plan §1.3), scoped to a dialog. Fetched on open rather than
  // on mount, because this dialog sits on a page that may never open it, and
  // the radio list renders identically once the plans land.
  const [choices, setChoices] = React.useState<PlanChoice[]>([]);
  const [pick, setPick] = React.useState(currentPlan);

  React.useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    getPlanChoices(controller.signal)
      .then((rows) => {
        if (!controller.signal.aborted) setChoices(rows);
      })
      .catch(() => {
        // The dialog has no error branch in the design; an unreadable catalogue
        // leaves the list empty rather than breaking the page behind it.
        if (!controller.signal.aborted) setChoices([]);
      });
    return () => controller.abort();
  }, [open]);
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Change plan · ${wsName}`}
      body="POST /api/lago/plan — the only route that moves an org between plans. The Redis plan cache is deleted, not rewritten."
      actions={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary">Move org</Button>
        </>
      }
    >
      <div className="flex flex-col gap-[6px]">
        {choices.map((p) => (
          <label
            key={p.plan_code}
            className="radio"
            style={{
              padding: "8px 0",
              borderBottom: "1px solid var(--color-divider)",
            }}
          >
            <input
              type="radio"
              name="pc"
              checked={pick === p.plan_code}
              onChange={() => setPick(p.plan_code)}
            />
            <span className="dot" />
            <span style={{ flex: 1 }}>
              <strong>{p.display_name}</strong>{" "}
              <span
                className="mono"
                style={{ fontSize: 12, color: "var(--color-neutral-600)" }}
              >
                {p.plan_code}
              </span>
            </span>
            <span style={{ fontSize: 12, color: "var(--color-neutral-600)" }}>
              {p.servicesSummary}
            </span>
          </label>
        ))}
      </div>
    </Dialog>
  );
}

export function TopUpDialog({
  open,
  onOpenChange,
  wsName,
  wallet,
}: Props & { wsName: string; wallet: number }) {
  const [credits, setCredits] = React.useState(500);
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Top up wallet · ${wsName}`}
      body={`POST /api/lago/wallet/topup. Current balance ${wallet} credits.`}
      actions={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary">Add credits</Button>
        </>
      }
    >
      <Field label="Credits">
        <Input
          type="number"
          value={credits}
          onChange={(e) => setCredits(Number(e.target.value))}
        />
      </Field>
      <Field label="Note">
        <Input placeholder="Goodwill credit for outage on 8 Sep" />
      </Field>
    </Dialog>
  );
}

export function PlatformKeyDialog({
  open,
  onOpenChange,
  rotateService,
}: Props & { rotateService?: string }) {
  const [service, setService] = React.useState(rotateService ?? "");
  const [value, setValue] = React.useState("");
  React.useEffect(() => {
    setService(rotateService ?? "");
    setValue("");
  }, [rotateService, open]);
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={rotateService ? `Rotate key · ${rotateService}` : "Add platform key"}
      body="PUT /api/platform-keys — upsert keyed on service. The value is encrypted with Helper.encrypt before storage and never returned in plaintext."
      actions={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!service || value.length < 8}>
            Save key
          </Button>
        </>
      }
    >
      <Field label="service">
        <Input
          value={service}
          onChange={(e) => setService(e.target.value)}
          readOnly={!!rotateService}
          placeholder="openai"
        />
      </Field>
      <Field label="apikey">
        <Input
          type="password"
          className="mono"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="sk-…"
        />
      </Field>
    </Dialog>
  );
}
