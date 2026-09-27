import WorkshopChecker.Model
/-! The executable activation checker. `Main` runs exactly `check`; the theorems are about `check`. -/
namespace Workshop

def live (o : Ob) : Bool := o.status == "open" || o.status == "blocked"

def adapterFor (i : Input) (o : Ob) : Option String :=
  (i.candidate.adapters.find? (fun a => a.fromPackage == o.continuation.packageHash && a.fromAction == o.continuation.action)).map (·.toAction)

/-- An action can carry a continuation: it exists, can submit evidence, and needs nothing outside the grant. -/
def actionOk (grant : List String) (acts : List ActionAttest) (name : String) : Bool :=
  acts.any (fun a => a.id == name && a.evidenceRoute && a.needs.all (fun c => grant.contains c))

def bound (i : Input) (o : Ob) : Bool := o.world == i.world && live o

/-- No obligation in the ledger, in any branch and any status, may lose its continuation package. -/
def retireOk (i : Input) : Bool :=
  i.obligations.all (fun o => !(i.candidate.retire.contains o.continuation.packageHash))

def dispositionOk (i : Input) (d : String) : Bool :=
  match i.dispositions.find? (fun x => x.id == d) with
  | none => false
  | some x => x.world == i.world && decide (x.revision ≤ i.revision) &&
      match i.obligations.find? (fun o => o.id == x.obligation) with
      | none => false
      | some o => o.status == (if x.kind == "cancel" then "cancelled_by_owner" else "superseded_by_owner") && o.successor == x.successor

def authOk (i : Input) (a : Approval) : Bool := a.issuedBy == "host" && a.owner == "owner" && a.inst == i.inst
def identityOk (i : Input) (a : Approval) : Bool := a.candidateHash == i.candidateHash && a.previewHash == i.previewHash
def freshOk (i : Input) (a : Approval) : Bool :=
  i.revision == a.expectedRevision && i.revision == i.baseRevision && i.stateDigest == i.baseDigest

/-- R03 algorithm: one typed witness per obligation, with a specific reason when there is none. -/
inductive Witness where
  | adapted (toAction : String)
  | pinned
  | missing (reason : String)

def pinnedWitness (i : Input) (o : Ob) : Witness :=
  match i.packages.find? (fun p => p.hash == o.continuation.packageHash) with
  | none => .missing s!"{o.id}: its continuation package is not retained"
  | some p =>
    if !p.available then .missing s!"{o.id}: its continuation package is unavailable"
    else if !p.interpreterOk then .missing s!"{o.id}: no supported interpreter remains for its continuation"
    else if !p.schemaCompatible then .missing s!"{o.id}: its continuation can no longer read or write its records"
    else if i.candidate.retire.contains p.hash then .missing s!"{o.id}: the candidate retires its continuation package"
    else if !actionOk i.grant p.actions o.continuation.action then .missing s!"{o.id}: continuation {o.continuation.action} is missing or lacks a granted capability"
    else .pinned

def witnessFor (i : Input) (o : Ob) : Witness :=
  if !o.artifacts.all (fun a => i.artifacts.contains a) then .missing s!"{o.id}: a referenced artifact is missing"
  else if !o.subjects.all (fun s => i.records.contains s) then .missing s!"{o.id}: a subject record is missing"
  else match adapterFor i o with
    | some t => if actionOk i.grant i.candidate.actions t then .adapted t else .missing s!"{o.id}: adapter target {t} cannot carry the continuation"
    | none => pinnedWitness i o

/-- Reconcile a list of obligations into (reasons, rebinds) in one pass. -/
def reconcile (i : Input) : List Ob → List String × List Rebind
  | [] => ([], [])
  | o :: os =>
    let r := reconcile i os
    match witnessFor i o with
    | .adapted t => (r.1, ⟨o.id, i.candidate.hash, t⟩ :: r.2)
    | .pinned => r
    | .missing why => (why :: r.1, r.2)

def check (i : Input) : Result :=
  match i.approval with
  | none => .reject ["no owner approval receipt issued by the host"]
  | some a =>
    if !authOk i a then .reject ["the approval was not issued by this host for its owner"]
    else if !identityOk i a then .reject ["the approval names a different candidate or preview"]
    else if !freshOk i a then .reject ["the project changed after this preview"]
    else
      let r := reconcile i (i.obligations.filter (bound i))
      if r.1.isEmpty && retireOk i && a.dispositions.all (dispositionOk i) then .accept r.2
      else .reject (r.1 ++ (if retireOk i then [] else ["the candidate retires a package an obligation still needs"])
        ++ (if a.dispositions.all (dispositionOk i) then [] else ["an approval disposition is not committed"]))

end Workshop
