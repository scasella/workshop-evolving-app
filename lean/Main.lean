import WorkshopChecker.Check
open Lean Workshop

/-- Reads one canonical activation input on stdin, writes the verdict on stdout. Fails closed. -/
def main (args : List String) : IO UInt32 := do
  let s ← (← IO.getStdin).readToEnd
  match Json.parse s >>= fromJson? (α := Input) with
  | .ok i =>
    -- --roundtrip re-emits the parsed input so the host can test the serialization boundary.
    if args.contains "--roundtrip" then IO.println (toJson i).compress else IO.println (toJson (check i)).compress
    pure 0
  | .error e => IO.println (Json.mkObj [("accept", false), ("reasons", toJson [s!"malformed checker input: {e}"])]).compress; pure 2
