import WorkshopChecker.Model
/-! The executable activation checker. `Main` runs exactly `check`; the theorems are about `check`. -/
namespace Workshop

def live (o : Ob) : Bool := o.status == "open" || o.status == "blocked"

def adapterFor (i : Input) (o : Ob) : Option String :=
  (i.candidate.adapters.find? (fun a => a.fromPackage == o.continuation.packageHash && a.fromAction == o.continuation.action)).map (·.toAction)

/-- An action can carry a continuation: it exists, can submit evidence, and needs nothing outside the grant. -/
def actionOk (grant : List String) (acts : List ActionAttest) (name : String) : Bool :=
  acts.any (fun a => a.id == name && a.evidenceRoute && a.needs.all (fun c => grant.contains c))

def pinnedOk (i : Input) (o : Ob) : Bool :=
  match i.packages.find? (fun p => p.hash == o.continuation.packageHash) with
  | none => false
  | some p => p.available && p.interpreterOk && p.schemaCompatible && !(i.candidate.retire.contains p.hash)
      && actionOk i.grant p.actions o.continuation.action

def routeOk (i : Input) (o : Ob) : Bool :=
  match adapterFor i o with
  | some t => actionOk i.grant i.candidate.actions t
  | none => pinnedOk i o

def witnessOk (i : Input) (o : Ob) : Bool :=
  routeOk i o && o.artifacts.all (fun a => i.artifacts.contains a) && o.subjects.all (fun s => i.records.contains s)

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

def rebinds (i : Input) : List Rebind :=
  (i.obligations.filter (bound i)).filterMap (fun o => (adapterFor i o).map (fun t => ⟨o.id, i.candidate.hash, t⟩))

def problems (i : Input) : List String :=
  ((i.obligations.filter (bound i)).filter (fun o => !witnessOk i o)).map (fun o => s!"no continuation witness for {o.id}")
  ++ (if retireOk i then [] else ["the candidate retires a package an obligation still needs"])

def check (i : Input) : Result :=
  match i.approval with
  | none => .reject ["no owner approval receipt issued by the host"]
  | some a =>
    if !authOk i a then .reject ["the approval was not issued by this host for its owner"]
    else if !identityOk i a then .reject ["the approval names a different candidate or preview"]
    else if !freshOk i a then .reject ["the project changed after this preview"]
    else if (i.obligations.filter (bound i)).all (witnessOk i) && retireOk i && a.dispositions.all (dispositionOk i) then
      .accept (rebinds i)
    else .reject (problems i ++ (if a.dispositions.all (dispositionOk i) then [] else ["an approval disposition is not committed"]))

end Workshop
