import type { RunPolicy } from "@baton/protocol";
import { Toggle } from "./common.js";

export function LeadReviewToggle({ policy, change, disabled }: { policy: RunPolicy; change: (checked: boolean) => void; disabled?: boolean }) {
  if (policy.mode === "solo") return null;
  return <div className="policy-row"><Toggle label="主导者验收改动" checked={policy.leadReview === true} onChange={change} disabled={disabled} />
    <p>开启后主导者必须亲自查看 diff、跑测试验收成员的改动，不合格会打回。</p>
  </div>;
}
