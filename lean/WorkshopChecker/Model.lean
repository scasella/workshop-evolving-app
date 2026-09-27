import Lean.Data.Json
/-!
Canonical activation input, as emitted by the Workshop host (`src/host/rcheck.ts`).
Everything here is data. Facts the checker cannot compute itself (package
availability, interpreter support, schema compatibility, capability needs of an
action) arrive as explicit host attestations; the theorems are relative to them.
-/
namespace Workshop
open Lean

structure Policy where
  verdicts : List String
  discharge : String
  independent : Bool
deriving FromJson, ToJson, DecidableEq, Repr

structure Cont where
  packageHash : String
  action : String
deriving FromJson, ToJson, DecidableEq, Repr

structure Ob where
  id : String
  world : String
  status : String
  subjects : List String
  policy : Policy
  gate : Option String
  successor : Option String
  continuation : Cont
  artifacts : List String
deriving FromJson, ToJson, DecidableEq, Repr

structure Disp where
  id : String
  obligation : String
  kind : String
  successor : Option String
  revision : Nat
  world : String
deriving FromJson, ToJson, DecidableEq, Repr

/-- The owner approval receipt. It is a host-supplied field of the input, never part of candidate data. -/
structure Approval where
  issuedBy : String
  owner : String
  inst : String
  candidateHash : String
  previewHash : String
  expectedRevision : Nat
  dispositions : List String
deriving FromJson, ToJson, DecidableEq, Repr

structure ActionAttest where
  id : String
  evidenceRoute : Bool
  needs : List String
deriving FromJson, ToJson, DecidableEq, Repr

structure PkgAttest where
  hash : String
  available : Bool
  interpreterOk : Bool
  schemaCompatible : Bool
  actions : List ActionAttest
deriving FromJson, ToJson, DecidableEq, Repr

structure Adapter where
  fromPackage : String
  fromAction : String
  toAction : String
deriving FromJson, ToJson, DecidableEq, Repr

structure Candidate where
  hash : String
  retire : List String
  adapters : List Adapter
  actions : List ActionAttest
deriving FromJson, ToJson, DecidableEq, Repr

structure Input where
  world : String
  inst : String
  revision : Nat
  stateDigest : String
  baseRevision : Nat
  baseDigest : String
  candidateHash : String
  previewHash : String
  approval : Option Approval
  obligations : List Ob
  dispositions : List Disp
  candidate : Candidate
  grant : List String
  packages : List PkgAttest
  records : List String
  artifacts : List String
deriving FromJson, ToJson, Repr

/-- The only obligation mutation an accepted activation may perform. -/
structure Rebind where
  obligation : String
  packageHash : String
  action : String
deriving FromJson, ToJson, DecidableEq, Repr

inductive Result where
  | accept (rebinds : List Rebind)
  | reject (reasons : List String)
deriving Repr

instance : ToJson Result where
  toJson
    | .accept rs => Json.mkObj [("accept", true), ("rebinds", toJson rs)]
    | .reject rs => Json.mkObj [("accept", false), ("reasons", toJson rs)]

end Workshop
