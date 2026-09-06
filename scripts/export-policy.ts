/**
 * A bit's policy as ODRL 2.2 (PLAN-4.md Phase 19, ADR 0014), for anyone
 * whose tools speak it. The enforced form is the passport's `policy`
 * (SPEC.md §9.8); this is a rendering of it, one to one:
 *
 *   controllers     → permission, action odrl:modify on the passport, per assignee
 *   actors.allow    → permission, action vpb:change, per assignee
 *   actors.deny     → prohibition, action vpb:change, per assignee
 *   agents: false   → prohibition, action vpb:change, assignee vpb:agents
 *   work            → permission, action vpb:work, constraint vpb:kind isAnyOf
 *
 *   npm run scene:policy -- <folder> <bit id> [out.json]
 */
import { promises as fs } from "node:fs";
import { type Policy, policyOf } from "../src/policy.ts";
import { passportPath, type PassportFile } from "../src/scene.ts";
import { NodeFsStore } from "../src/store-node.ts";

export const VPB_ODRL_CONTEXT = "https://skinnerboxentertainment.github.io/VoxelPixelThingie/ns/policy/";

export interface OdrlRule {
  action: string | { "@id": string };
  target: string;
  assignee?: string;
  constraint?: { leftOperand: string; operator: string; rightOperand: string[] }[];
}

export interface OdrlPolicy {
  "@context": (string | Record<string, string>)[];
  "@type": "Set";
  uid: string;
  profile: string;
  permission: OdrlRule[];
  prohibition: OdrlRule[];
}

const actorIri = (pattern: string) => `${VPB_ODRL_CONTEXT}actor/${encodeURIComponent(pattern)}`;

/** The ODRL Set for one bit's policy. An absent policy is an empty set: nothing constrained. */
export function toOdrl(bitIri: string, policy: Policy | undefined): OdrlPolicy {
  const out: OdrlPolicy = {
    "@context": ["http://www.w3.org/ns/odrl.jsonld", { vpb: VPB_ODRL_CONTEXT }],
    "@type": "Set",
    uid: `${bitIri}#policy`,
    profile: `${VPB_ODRL_CONTEXT}profile/1`,
    permission: [],
    prohibition: [],
  };
  if (!policy) return out;
  for (const c of policy.controllers ?? [])
    out.permission.push({ action: "modify", target: `${bitIri}/passport`, assignee: actorIri(c) });
  for (const a of policy.actors?.allow ?? [])
    out.permission.push({ action: { "@id": "vpb:change" }, target: bitIri, assignee: actorIri(a) });
  for (const d of policy.actors?.deny ?? [])
    out.prohibition.push({ action: { "@id": "vpb:change" }, target: bitIri, assignee: actorIri(d) });
  if (policy.agents === false)
    out.prohibition.push({ action: { "@id": "vpb:change" }, target: bitIri, assignee: `${VPB_ODRL_CONTEXT}agents` });
  if (policy.work)
    out.permission.push({
      action: { "@id": "vpb:work" },
      target: bitIri,
      constraint: [{ leftOperand: "vpb:kind", operator: "isAnyOf", rightOperand: policy.work }],
    });
  return out;
}

async function main(): Promise<void> {
  const [folder, bitId, out] = process.argv.slice(2);
  if (!folder || !bitId) {
    console.error("usage: export-policy <folder> <bit id> [out.json]");
    process.exit(2);
  }
  const store = new NodeFsStore(folder);
  const text = await store.read(passportPath(bitId));
  if (!text) {
    console.error(`no bit ${bitId} in ${folder}`);
    process.exit(1);
  }
  const passport = JSON.parse(text) as PassportFile;
  const odrl = toOdrl(`https://skinnerboxentertainment.github.io/VoxelPixelThingie/ns/bit/${bitId}`, policyOf(passport.passport));
  const json = `${JSON.stringify(odrl, null, 2)}\n`;
  if (out) await fs.writeFile(out, json, "utf8");
  else process.stdout.write(json);
}

if (process.argv[1] && /export-policy\.ts$/.test(process.argv[1])) await main();
