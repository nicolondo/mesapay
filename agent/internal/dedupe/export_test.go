package dedupe

// setMaxEntries baja el tope para poder probar la poda sin escribir
// miles de veces al disco (cada Mark hace fsync).
func (s *Store) setMaxEntries(n int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.maxEntries = n
}
