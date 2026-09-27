import WorkshopChecker.Check
/-!
# The fixed contract for research release R

These statements are pinned by hash (`lean/contract.sha256`); `npm run r:build` refuses a
changed contract. The checker implementation may change (R03) but must re-prove exactly these.
They are phrased over input data only, never over the checker's helper functions, so an
algorithm change cannot silently change their meaning. The one implementation name used is
`check` itself, the function the host executes.

Trusted assumptions: faithful host serialization of `Input` (round-trip tested), truthful host
attestations (`PkgAttest`, `ActionAttest`, `records`, `artifacts`), and the host applying exactly
the returned rebinds in one SQLite transaction after rechecking the revision.
-/
namespace Workshop.Contract
open Workshop

def isLive (o : Ob) : Prop := o.status = "open" ∨ o.status = "blocked"

/-- An action that can carry a continuation under the approved grant. -/
def Carries (grant : List String) (acts : List ActionAttest) (name : String) : Prop :=
  ∃ act ∈ acts, act.id = name ∧ act.evidenceRoute = true ∧ ∀ c ∈ act.needs, c ∈ grant

/-- The candidate's adapter for this continuation, if the candidate declares one (first match). -/
def AdapterIs (i : Input) (o : Ob) (t : Option String) : Prop :=
  t = ((i.candidate.adapters.find? (fun a => a.fromPackage == o.continuation.packageHash && a.fromAction == o.continuation.action)).map (·.toAction))

/-- A continuation route, stated over input data. -/
def Route (i : Input) (o : Ob) : Prop :=
  (∃ t, AdapterIs i o (some t) ∧ Carries i.grant i.candidate.actions t) ∨
  (AdapterIs i o none ∧ ∃ p ∈ i.packages, p.hash = o.continuation.packageHash ∧ p.available = true ∧
    p.interpreterOk = true ∧ p.schemaCompatible = true ∧ p.hash ∉ i.candidate.retire ∧
    Carries i.grant p.actions o.continuation.action)

/-- C3: every live obligation of the world keeps a continuation route, its artifacts and its subjects. -/
def Preservation : Prop :=
  ∀ i rs, check i = .accept rs → ∀ o ∈ i.obligations, o.world = i.world → isLive o →
    Route i o ∧ (∀ x ∈ o.artifacts, x ∈ i.artifacts) ∧ (∀ s ∈ o.subjects, s ∈ i.records)

/-- No obligation anywhere in the ledger loses its continuation package to `retire`. -/
def NoRetiredContinuation : Prop :=
  ∀ i rs, check i = .accept rs → ∀ o ∈ i.obligations, o.continuation.packageHash ∉ i.candidate.retire

/-- The plan is only rebinds of live obligations of this world onto candidate adapter actions. -/
def RebindsSound : Prop :=
  ∀ i rs, check i = .accept rs → ∀ r ∈ rs, ∃ o ∈ i.obligations, o.id = r.obligation ∧ o.world = i.world ∧ isLive o ∧
    r.packageHash = i.candidate.hash ∧ AdapterIs i o (some r.action) ∧ Carries i.grant i.candidate.actions r.action

/-- Applying rebinds keeps identity and the original discharge rule. -/
def applyRebinds (rs : List Rebind) (o : Ob) : Ob :=
  match rs.find? (fun r => r.obligation == o.id) with
  | none => o
  | some r => { o with continuation := ⟨r.packageHash, r.action⟩ }
def KeepsIdentityAndRule : Prop :=
  ∀ rs o, (applyRebinds rs o).id = o.id ∧ (applyRebinds rs o).subjects = o.subjects ∧ (applyRebinds rs o).policy = o.policy ∧
    (applyRebinds rs o).status = o.status ∧ (applyRebinds rs o).gate = o.gate ∧ (applyRebinds rs o).successor = o.successor

/-- C5: package-authored approval is never owner authority. -/
def OwnerApproval : Prop :=
  ∀ i rs, check i = .accept rs → ∃ a, i.approval = some a ∧ a.issuedBy = "host" ∧ a.owner = "owner" ∧ a.inst = i.inst ∧
    a.candidateHash = i.candidateHash ∧ a.previewHash = i.previewHash

/-- C4: a stale base revision or state is rejected. -/
def StaleRejected : Prop :=
  ∀ i a, i.approval = some a → (i.revision ≠ a.expectedRevision ∨ i.revision ≠ i.baseRevision ∨ i.stateDigest ≠ i.baseDigest) →
    ∃ rs, check i = .reject rs

/-- Dispositions referenced by an accepted approval are committed, of this world, not from the future,
and the obligation carries exactly that disposition. -/
def DispositionsCommitted : Prop :=
  ∀ i rs, check i = .accept rs → ∃ a, i.approval = some a ∧ ∀ d ∈ a.dispositions, ∃ x ∈ i.dispositions, x.id = d ∧
    x.world = i.world ∧ x.revision ≤ i.revision ∧ ∃ o ∈ i.obligations, o.id = x.obligation ∧
    o.status = (if x.kind = "cancel" then "cancelled_by_owner" else "superseded_by_owner") ∧ o.successor = x.successor

end Workshop.Contract
