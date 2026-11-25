package main

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const (
	schemaDirectory        = "../schema"
	validFixtures          = "../schema/fixtures/valid"
	invalidFixtures        = "../schema/fixtures/invalid"
	fixtureRelease         = "2.0.0"
	agentsCatalogueFile    = "agents-of-the-imperium.json"
	agentsCatalogueContent = `{"id": "agents-of-the-imperium", "name": "Agents", "kind": "Faction", "factionKeyword": "IMPERIUM", "datasheets": {"lord": {
		"name": "Lord", "battlefieldRole": "HQ", "cost": 1, "keywords": ["CHARACTER"], "factionKeywords": ["IMPERIUM"],
		"profiles": [{"name": "Lord", "movement": {"kind": "Immobile"}, "wounds": 1, "save": 4}]}}}`
)

func mustCompileSchemas(t *testing.T) *Schemas {
	t.Helper()
	schemas, err := compileSchemas(schemaDirectory)
	if err != nil {
		t.Fatal(err)
	}
	return schemas
}

func TestValidFixturesPass(t *testing.T) {
	var stdout, stderr bytes.Buffer
	exitCode := run([]string{"-data", validFixtures, "-schema", schemaDirectory, "-release", fixtureRelease}, ".", &stdout, &stderr)
	if exitCode != exitOK {
		t.Fatalf("exit %d\n%s%s", exitCode, stdout.String(), stderr.String())
	}
	if !strings.Contains(stdout.String(), "valid") {
		t.Errorf("stdout %q does not say valid", stdout.String())
	}
}

func TestEveryInvalidFixtureIsRejected(t *testing.T) {
	schemas := mustCompileSchemas(t)
	paths, err := filepath.Glob(filepath.Join(invalidFixtures, "*.json"))
	if err != nil || len(paths) == 0 {
		t.Fatalf("no invalid fixtures: %v", err)
	}
	for _, path := range paths {
		content, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		problems := checkFile(schemas.Catalogue, content, &Catalogue{})
		if len(problems) != 1 || !strings.HasPrefix(problems[0], "does not match the schema") {
			t.Errorf("%s: want only a schema violation, got %v", filepath.Base(path), problems)
		}
	}
}

// writeDataset makes a data set of the valid game system plus the given catalogue files.
func writeDataset(t *testing.T, catalogues map[string]string) string {
	t.Helper()
	directory := t.TempDir()
	gameSystem, err := os.ReadFile(filepath.Join(validFixtures, gameSystemFileName))
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(directory, gameSystemFileName), gameSystem, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(directory, cataloguesDirectory), 0o700); err != nil {
		t.Fatal(err)
	}
	for name, content := range catalogues {
		if err := os.WriteFile(filepath.Join(directory, cataloguesDirectory, name), []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	return directory
}

func TestRunReportsProblems(t *testing.T) {
	tests := []struct {
		name    string
		content string
		want    string
	}{
		{"schema violation", `{"id": "agents-of-the-imperium", "name": "Agents", "kind": "Army"}`, "does not match the schema"},
		{"duplicate key", `{"id": "agents-of-the-imperium", "id": "agents-of-the-imperium", "name": "Agents", "kind": "Faction", "factionKeyword": "IMPERIUM"}`, "duplicate key /id"},
		{"broken JSON", `{"id": `, "not valid JSON"},
		{"content after the JSON", agentsCatalogueContent + ` {}`, "not valid JSON"},
		{"dangling import", `{"id": "agents-of-the-imperium", "name": "Agents", "kind": "Faction", "factionKeyword": "IMPERIUM", "imports": ["ghost"]}`, `"ghost" is not a library catalogue`},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			directory := writeDataset(t, map[string]string{agentsCatalogueFile: test.content})
			var stdout, stderr bytes.Buffer
			exitCode := run([]string{"-data", directory, "-schema", schemaDirectory}, ".", &stdout, &stderr)
			if exitCode != exitProblem {
				t.Fatalf("exit %d, want %d", exitCode, exitProblem)
			}
			if !strings.Contains(stdout.String(), "catalogues/"+agentsCatalogueFile) || !strings.Contains(stdout.String(), test.want) {
				t.Errorf("stdout %q lacks the file name or %q", stdout.String(), test.want)
			}
			if !strings.Contains(stderr.String(), "problem(s)") {
				t.Errorf("stderr %q has no summary", stderr.String())
			}
		})
	}
}

func TestRunAcceptsAMinimalDataset(t *testing.T) {
	directory := writeDataset(t, map[string]string{agentsCatalogueFile: agentsCatalogueContent})
	var stdout, stderr bytes.Buffer
	if exitCode := run([]string{"-data", directory, "-schema", schemaDirectory}, ".", &stdout, &stderr); exitCode != exitOK {
		t.Fatalf("exit %d\n%s%s", exitCode, stdout.String(), stderr.String())
	}
}

func TestRunReportsAGameSystemProblem(t *testing.T) {
	directory := writeDataset(t, map[string]string{agentsCatalogueFile: agentsCatalogueContent})
	if err := os.WriteFile(filepath.Join(directory, gameSystemFileName), []byte(`{"release": "2.0.0"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	var stdout, stderr bytes.Buffer
	if exitCode := run([]string{"-data", directory, "-schema", schemaDirectory}, ".", &stdout, &stderr); exitCode != exitProblem {
		t.Fatalf("exit %d, want %d", exitCode, exitProblem)
	}
	if !strings.Contains(stdout.String(), gameSystemFileName+": does not match the schema") {
		t.Errorf("stdout %q does not name the game system", stdout.String())
	}
}

func TestRunUsageErrors(t *testing.T) {
	outsideRepository := t.TempDir()
	rootWithoutData := t.TempDir()
	if err := os.CopyFS(filepath.Join(rootWithoutData, "schema"), os.DirFS(schemaDirectory)); err != nil {
		t.Fatal(err)
	}
	tests := []struct {
		name             string
		arguments        []string
		workingDirectory string
		want             string
	}{
		{"unknown flag", []string{"-unknown"}, ".", "flag provided but not defined"},
		{"no repository root", nil, outsideRepository, "pass -data and -schema"},
		{"default data directory missing", nil, rootWithoutData, filepath.Join("data", gameSystemFileName)},
		{"schema directory missing", []string{"-data", validFixtures, "-schema", outsideRepository}, ".", commonSchemaFile},
		{"no catalogues directory needed but game system is", []string{"-data", outsideRepository, "-schema", schemaDirectory}, ".", gameSystemFileName},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			var stdout, stderr bytes.Buffer
			if exitCode := run(test.arguments, test.workingDirectory, &stdout, &stderr); exitCode != exitUsage {
				t.Fatalf("exit %d, want %d", exitCode, exitUsage)
			}
			if !strings.Contains(stderr.String(), test.want) {
				t.Errorf("stderr %q lacks %q", stderr.String(), test.want)
			}
		})
	}
}

func TestDefaultDirectoriesComeFromTheRepositoryRoot(t *testing.T) {
	root := t.TempDir()
	if err := os.CopyFS(filepath.Join(root, "schema"), os.DirFS(schemaDirectory)); err != nil {
		t.Fatal(err)
	}
	if err := os.CopyFS(filepath.Join(root, "data"), os.DirFS(validFixtures)); err != nil {
		t.Fatal(err)
	}
	nested := filepath.Join(root, "validator", "deeper")
	if err := os.MkdirAll(nested, 0o700); err != nil {
		t.Fatal(err)
	}
	var stdout, stderr bytes.Buffer
	if exitCode := run(nil, nested, &stdout, &stderr); exitCode != exitOK {
		t.Fatalf("exit %d\n%s%s", exitCode, stdout.String(), stderr.String())
	}
}

func TestSchemaWithoutIdentifierIsRejected(t *testing.T) {
	directory := t.TempDir()
	if err := os.CopyFS(directory, os.DirFS(schemaDirectory)); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(directory, commonSchemaFile), []byte(`{"type": "object"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := compileSchemas(directory); err == nil || !strings.Contains(err.Error(), "no $id") {
		t.Errorf("got %v, want a missing $id error", err)
	}
}

func TestDuplicateKeysAreFoundAtAnyDepth(t *testing.T) {
	duplicates, err := duplicateKeys([]byte(`{"a": [{"b": 1, "b": 2}], "c": {"d": {}, "d": []}}`))
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"/a/0/b", "/c/d"}
	if strings.Join(duplicates, ",") != strings.Join(want, ",") {
		t.Errorf("got %v, want %v", duplicates, want)
	}
}
