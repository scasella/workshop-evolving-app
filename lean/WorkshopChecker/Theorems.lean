import WorkshopChecker.Contract
/-! Proofs that the executing checker `Workshop.check` satisfies the fixed contract. -/
namespace Workshop
open Workshop.Contract

theorem contains_true {s : String} {l : List String} (h : l.contains s = true) : s ∈ l := by
  simpa using h
theorem contains_false {s : String} {l : List String} (h : l.contains s = false) : s ∉ l := by
  intro hm; have := List.contains_iff_mem.mpr hm; simp_all

theorem actionOk_sound {grant : List String} {acts : List ActionAttest} {name : String}
    (h : actionOk grant acts name = true) : Carries grant acts name := by
  simp only [actionOk, List.any_eq_true, Bool.and_eq_true, beq_iff_eq, List.all_eq_true] at h
  obtain ⟨act, hm, ⟨hid, hev⟩, hneeds⟩ := h
  exact ⟨act, hm, hid, hev, fun c hc => contains_true (hneeds c hc)⟩

theorem live_sound {o : Ob} (h : live o = true) : isLive o := by
  simp only [live, Bool.or_eq_true, beq_iff_eq] at h; exact h

/-- Simp set for reducing the checker's Boolean `if`s once each condition is a literal. -/
macro "reduce_ifs" h:ident : tactic => `(tactic| simp only [Bool.not_true, Bool.not_false, Bool.false_eq_true, ite_true, ite_false,
  if_true, if_false, eq_self_iff_true, reduceCtorEq, Witness.adapted.injEq, Witness.missing.injEq] at $h:ident)

theorem pinnedWitness_sound {i : Input} {o : Ob} (h : pinnedWitness i o = .pinned) :
    ∃ p ∈ i.packages, p.hash = o.continuation.packageHash ∧ p.available = true ∧ p.interpreterOk = true ∧
      p.schemaCompatible = true ∧ p.hash ∉ i.candidate.retire ∧ Carries i.grant p.actions o.continuation.action := by
  unfold pinnedWitness at h
  cases hp : i.packages.find? (fun p => p.hash == o.continuation.packageHash) with
  | none => rw [hp] at h; cases h
  | some p =>
    rw [hp] at h; simp only at h
    have hmem := List.mem_of_find?_eq_some hp
    have hhash := List.find?_some hp
    simp only [beq_iff_eq] at hhash
    cases h1 : p.available <;> cases h2 : p.interpreterOk <;> cases h3 : p.schemaCompatible <;>
      cases h4 : i.candidate.retire.contains p.hash <;> cases h5 : actionOk i.grant p.actions o.continuation.action <;>
      simp only [h1, h2, h3, h4, h5] at h <;> reduce_ifs h
    exact ⟨p, hmem, hhash, h1, h2, h3, contains_false h4, actionOk_sound h5⟩

theorem pinnedWitness_ne_adapted (i : Input) (o : Ob) (t : String) : pinnedWitness i o ≠ .adapted t := by
  intro h
  unfold pinnedWitness at h
  cases hp : i.packages.find? (fun p => p.hash == o.continuation.packageHash) with
  | none => rw [hp] at h; cases h
  | some p =>
    rw [hp] at h; simp only at h
    cases h1 : p.available <;> cases h2 : p.interpreterOk <;> cases h3 : p.schemaCompatible <;>
      cases h4 : i.candidate.retire.contains p.hash <;> cases h5 : actionOk i.grant p.actions o.continuation.action <;>
      simp only [h1, h2, h3, h4, h5] at h <;> reduce_ifs h

theorem witnessFor_present {i : Input} {o : Ob} (h : ∀ why, witnessFor i o ≠ .missing why) :
    o.artifacts.all (fun a => i.artifacts.contains a) = true ∧ o.subjects.all (fun s => i.records.contains s) = true := by
  unfold witnessFor at h
  cases ha : o.artifacts.all (fun a => i.artifacts.contains a) <;> cases hs : o.subjects.all (fun s => i.records.contains s) <;>
    simp only [ha, hs] at h
  all_goals first | exact ⟨rfl, rfl⟩ | exact absurd rfl (h _)

theorem witnessFor_route {i : Input} {o : Ob} (h : ∀ why, witnessFor i o ≠ .missing why) : Route i o := by
  have ⟨ha, hs⟩ := witnessFor_present h
  unfold witnessFor at h
  simp only [ha, hs] at h
  cases hat : adapterFor i o with
  | some t =>
    simp only [hat] at h
    cases hok : actionOk i.grant i.candidate.actions t
    · simp only [hok] at h; exact absurd rfl (h _)
    · exact Or.inl ⟨t, hat.symm, actionOk_sound hok⟩
  | none =>
    simp only [hat] at h
    cases hw : pinnedWitness i o with
    | pinned => exact Or.inr ⟨hat.symm, pinnedWitness_sound hw⟩
    | adapted t => exact absurd hw (pinnedWitness_ne_adapted i o t)
    | missing why => rw [hw] at h; exact absurd rfl (h why)

theorem witnessFor_adapted {i : Input} {o : Ob} {t : String} (h : witnessFor i o = .adapted t) :
    adapterFor i o = some t ∧ actionOk i.grant i.candidate.actions t = true := by
  unfold witnessFor at h
  cases ha : o.artifacts.all (fun a => i.artifacts.contains a) <;> cases hs : o.subjects.all (fun s => i.records.contains s) <;>
    simp only [ha, hs] at h <;> try reduce_ifs h
  cases hat : adapterFor i o with
  | some t' =>
    simp only [hat] at h
    cases hok : actionOk i.grant i.candidate.actions t' <;> simp only [hok] at h <;> reduce_ifs h
    subst h; exact ⟨rfl, hok⟩
  | none =>
    simp only [hat] at h
    exact absurd h (pinnedWitness_ne_adapted i o t)

theorem reconcile_complete (i : Input) : ∀ (l : List Ob), (reconcile i l).1 = [] → ∀ o ∈ l, ∀ why, witnessFor i o ≠ .missing why
  | [], _, o, ho, _ => by cases ho
  | o :: os, h, x, hx, why => by
    simp only [reconcile] at h
    cases hw : witnessFor i o with
    | missing w => rw [hw] at h; cases h
    | adapted t =>
      rw [hw] at h
      rcases List.mem_cons.mp hx with rfl | hx
      · rw [hw]; intro hc; cases hc
      · exact reconcile_complete i os h x hx why
    | pinned =>
      rw [hw] at h
      rcases List.mem_cons.mp hx with rfl | hx
      · rw [hw]; intro hc; cases hc
      · exact reconcile_complete i os h x hx why

theorem reconcile_rebinds (i : Input) : ∀ (l : List Ob) (r : Rebind), r ∈ (reconcile i l).2 →
    ∃ o ∈ l, ∃ t, witnessFor i o = .adapted t ∧ r = ⟨o.id, i.candidate.hash, t⟩
  | [], r, h => by simp [reconcile] at h
  | o :: os, r, h => by
    simp only [reconcile] at h
    cases hw : witnessFor i o with
    | missing w =>
      rw [hw] at h
      obtain ⟨x, hx, t, ht, hr⟩ := reconcile_rebinds i os r h
      exact ⟨x, List.mem_cons_of_mem o hx, t, ht, hr⟩
    | pinned =>
      rw [hw] at h
      obtain ⟨x, hx, t, ht, hr⟩ := reconcile_rebinds i os r h
      exact ⟨x, List.mem_cons_of_mem o hx, t, ht, hr⟩
    | adapted t =>
      rw [hw] at h
      rcases List.mem_cons.mp h with rfl | h
      · exact ⟨o, List.mem_cons_self .., t, hw, rfl⟩
      · obtain ⟨x, hx, t', ht, hr⟩ := reconcile_rebinds i os r h
        exact ⟨x, List.mem_cons_of_mem o hx, t', ht, hr⟩

/-- Shared unfolding: an accepted input passed every gate, with the approval it names. -/
theorem accept_gates (i : Input) (rs : List Rebind) (h : check i = .accept rs) :
    ∃ a, i.approval = some a ∧ authOk i a = true ∧ identityOk i a = true ∧ freshOk i a = true ∧
      (reconcile i (i.obligations.filter (bound i))).1 = [] ∧ retireOk i = true ∧
      a.dispositions.all (dispositionOk i) = true ∧ rs = (reconcile i (i.obligations.filter (bound i))).2 := by
  unfold check at h
  cases ha : i.approval with
  | none => rw [ha] at h; cases h
  | some a =>
    rw [ha] at h
    simp only at h
    by_cases h1 : authOk i a = true
    · by_cases h2 : identityOk i a = true
      · by_cases h3 : freshOk i a = true
        · simp only [h1, h2, h3, Bool.not_true, Bool.false_eq_true, ite_false] at h
          by_cases h4 : ((reconcile i (i.obligations.filter (bound i))).1.isEmpty && retireOk i && a.dispositions.all (dispositionOk i)) = true
          · rw [if_pos h4] at h
            simp only [Bool.and_eq_true, List.isEmpty_iff] at h4
            exact ⟨a, rfl, h1, h2, h3, h4.1.1, h4.1.2, h4.2, (Result.accept.inj h).symm⟩
          · rw [if_neg h4] at h; cases h
        · simp only [h1, h2, Bool.not_true, Bool.false_eq_true, ite_false] at h
          rw [if_pos (by simpa using h3)] at h; cases h
      · simp only [h1, Bool.not_true, Bool.false_eq_true, ite_false] at h
        rw [if_pos (by simpa using h2)] at h; cases h
    · rw [if_pos (by simpa using h1)] at h; cases h

theorem preservation : Preservation := by
  intro i rs h o ho hw hl
  obtain ⟨a, -, -, -, -, hnil, -, -, -⟩ := accept_gates i rs h
  have hl' : live o = true := by
    rcases hl with hl | hl <;> simp [live, hl]
  have hb : bound i o = true := by simp [bound, hw, hl']
  have hok := reconcile_complete i _ hnil o (List.mem_filter.mpr ⟨ho, hb⟩)
  have ⟨ha, hs⟩ := witnessFor_present hok
  simp only [List.all_eq_true] at ha hs
  exact ⟨witnessFor_route hok, fun x hx => contains_true (ha x hx), fun s hs' => contains_true (hs s hs')⟩

theorem no_retired_continuation : NoRetiredContinuation := by
  intro i rs h o ho
  obtain ⟨a, -, -, -, -, -, hr, -, -⟩ := accept_gates i rs h
  have := (List.all_eq_true.mp hr) o ho
  simp only [Bool.not_eq_true'] at this
  exact contains_false this

theorem rebinds_sound : RebindsSound := by
  intro i rs h r hr
  obtain ⟨a, -, -, -, -, -, -, -, hrs⟩ := accept_gates i rs h
  subst hrs
  obtain ⟨o, hmem, t, hw, rfl⟩ := reconcile_rebinds i _ r hr
  have ⟨ho, hb⟩ := List.mem_filter.mp hmem
  have ⟨hat, hok⟩ := witnessFor_adapted hw
  simp only [bound, Bool.and_eq_true, beq_iff_eq] at hb
  exact ⟨o, ho, rfl, hb.1, live_sound hb.2, rfl, hat.symm, actionOk_sound hok⟩

theorem keeps_identity_and_rule : KeepsIdentityAndRule := by
  intro rs o
  simp only [Contract.applyRebinds]
  split <;> exact ⟨rfl, rfl, rfl, rfl, rfl, rfl⟩

theorem owner_approval : OwnerApproval := by
  intro i rs h
  obtain ⟨a, ha, h1, h2, -, -, -, -, -⟩ := accept_gates i rs h
  simp only [authOk, identityOk, Bool.and_eq_true, beq_iff_eq] at h1 h2
  exact ⟨a, ha, h1.1.1, h1.1.2, h1.2, h2.1, h2.2⟩

theorem stale_rejected : StaleRejected := by
  intro i a ha hs
  cases hc : check i with
  | reject rs => exact ⟨rs, rfl⟩
  | accept rs =>
    obtain ⟨a', ha', -, -, h3, -, -, -, -⟩ := accept_gates i rs hc
    rw [ha] at ha'; cases ha'
    simp only [freshOk, Bool.and_eq_true, beq_iff_eq] at h3
    rcases hs with hs | hs | hs
    · exact absurd h3.1.1 hs
    · exact absurd h3.1.2 hs
    · exact absurd h3.2 hs

theorem dispositions_committed : DispositionsCommitted := by
  intro i rs h
  obtain ⟨a, ha, -, -, -, -, -, hd, -⟩ := accept_gates i rs h
  refine ⟨a, ha, fun d hdm => ?_⟩
  have hok := (List.all_eq_true.mp hd) d hdm
  unfold dispositionOk at hok
  cases hx : i.dispositions.find? (fun x => x.id == d) with
  | none => rw [hx] at hok; cases hok
  | some x =>
    rw [hx] at hok
    simp only at hok
    have hxm := List.mem_of_find?_eq_some hx
    have hxid := List.find?_some hx
    simp only [beq_iff_eq] at hxid
    cases ho : i.obligations.find? (fun o => o.id == x.obligation) with
    | none => rw [ho] at hok; simp at hok
    | some o =>
      rw [ho] at hok
      have hom := List.mem_of_find?_eq_some ho
      have hoid := List.find?_some ho
      simp only [beq_iff_eq] at hoid
      simp only [Bool.and_eq_true, beq_iff_eq, decide_eq_true_eq] at hok
      refine ⟨x, hxm, hxid, hok.1.1, hok.1.2, o, hom, hoid, ?_, hok.2.2⟩
      have hs := hok.2.1
      by_cases hk : x.kind = "cancel" <;> simp_all

end Workshop
