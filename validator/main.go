// Command validator checks a Fundapocalypse data set against the JSON Schema
// and the integrity rules in docs/data-format.md. It exits 1 on any problem.
package main

import (
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
)

const (
	exitOK      = 0
	exitProblem = 1
	exitUsage   = 2
)

func main() {
	workingDirectory, err := os.Getwd()
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(exitUsage)
	}
	os.Exit(run(os.Args[1:], workingDirectory, os.Stdout, os.Stderr))
}

func run(arguments []string, workingDirectory string, stdout io.Writer, stderr io.Writer) int {
	flags := flag.NewFlagSet("validator", flag.ContinueOnError)
	flags.SetOutput(stderr)
	dataDirectory := flags.String("data", "", "the data set to check: game-system.json and catalogues/ (default: data/ at the repo root)")
	schemaDirectory := flags.String("schema", "", "the schema directory (default: schema/ at the repo root)")
	release := flags.String("release", "", "the release being tagged, e.g. 2.0.0; game-system.json's release must match it")
	if err := flags.Parse(arguments); err != nil {
		return exitUsage
	}
	repositoryRoot, err := findRepositoryRoot(workingDirectory)
	if err != nil && (*dataDirectory == "" || *schemaDirectory == "") {
		fmt.Fprintln(stderr, err)
		return exitUsage
	}
	if *dataDirectory == "" {
		*dataDirectory = filepath.Join(repositoryRoot, "data")
	}
	if *schemaDirectory == "" {
		*schemaDirectory = filepath.Join(repositoryRoot, "schema")
	}
	var expectedRelease *string
	if *release != "" {
		expectedRelease = release
	}
	problems, err := validate(*schemaDirectory, *dataDirectory, expectedRelease)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return exitUsage
	}
	for _, problem := range problems {
		fmt.Fprintln(stdout, problem)
	}
	if len(problems) > 0 {
		fmt.Fprintf(stderr, "%s: %d problem(s)\n", *dataDirectory, len(problems))
		return exitProblem
	}
	fmt.Fprintf(stdout, "%s: valid\n", *dataDirectory)
	return exitOK
}

// validate runs the schema check and, only if every file passes it, the integrity rules.
func validate(schemaDirectory string, dataDirectory string, expectedRelease *string) ([]string, error) {
	schemas, err := compileSchemas(schemaDirectory)
	if err != nil {
		return nil, err
	}
	dataset, problems, err := loadDataset(schemas, dataDirectory)
	if err != nil || len(problems) > 0 {
		return problems, err
	}
	return checkIntegrity(dataset, expectedRelease), nil
}

// findRepositoryRoot walks up to the directory that holds schema/common.schema.json.
func findRepositoryRoot(start string) (string, error) {
	directory, err := filepath.Abs(start)
	if err != nil {
		return "", err
	}
	for {
		if _, err := os.Stat(filepath.Join(directory, "schema", commonSchemaFile)); err == nil {
			return directory, nil
		}
		parent := filepath.Dir(directory)
		if parent == directory {
			return "", errors.New("no schema/" + commonSchemaFile + " above " + start + "; pass -data and -schema")
		}
		directory = parent
	}
}
