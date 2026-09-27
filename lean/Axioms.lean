import WorkshopChecker
#print axioms Workshop.preservation
#print axioms Workshop.no_retired_continuation
#print axioms Workshop.rebinds_sound
#print axioms Workshop.keeps_identity_and_rule
#print axioms Workshop.owner_approval
#print axioms Workshop.stale_rejected
#print axioms Workshop.dispositions_committed
-- Each theorem must have exactly its fixed-contract type; a weakened restatement fails here.
example : Workshop.Contract.Preservation := Workshop.preservation
example : Workshop.Contract.NoRetiredContinuation := Workshop.no_retired_continuation
example : Workshop.Contract.RebindsSound := Workshop.rebinds_sound
example : Workshop.Contract.KeepsIdentityAndRule := Workshop.keeps_identity_and_rule
example : Workshop.Contract.OwnerApproval := Workshop.owner_approval
example : Workshop.Contract.StaleRejected := Workshop.stale_rejected
example : Workshop.Contract.DispositionsCommitted := Workshop.dispositions_committed
