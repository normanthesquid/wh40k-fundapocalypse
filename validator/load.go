package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/santhosh-tekuri/jsonschema/v6"
)

const (
	gameSystemFileName   = "game-system.json"
	cataloguesDirectory  = "catalogues"
	commonSchemaFile     = "common.schema.json"
	catalogueSchemaFile  = "catalogue.schema.json"
	gameSystemSchemaFile = "game-system.schema.json"
	jsonExtension        = ".json"
)

type Schemas struct {
	Catalogue  *jsonschema.Schema
	GameSystem *jsonschema.Schema
}

// compileSchemas registers each schema under its own $id, so their relative $refs resolve offline.
func compileSchemas(schemaDirectory string) (*Schemas, error) {
	compiler := jsonschema.NewCompiler()
	identifiers := map[string]string{}
	for _, fileName := range []string{commonSchemaFile, catalogueSchemaFile, gameSystemSchemaFile} {
		content, err := os.ReadFile(filepath.Join(schemaDirectory, fileName))
		if err != nil {
			return nil, err
		}
		document, err := jsonschema.UnmarshalJSON(bytes.NewReader(content))
		if err != nil {
			return nil, fmt.Errorf("%s: %w", fileName, err)
		}
		identifier, _ := document.(map[string]any)["$id"].(string)
		if identifier == "" {
			return nil, fmt.Errorf("%s: no $id", fileName)
		}
		if err := compiler.AddResource(identifier, document); err != nil {
			return nil, err
		}
		identifiers[fileName] = identifier
	}
	catalogue, err := compiler.Compile(identifiers[catalogueSchemaFile])
	if err != nil {
		return nil, err
	}
	gameSystem, err := compiler.Compile(identifiers[gameSystemSchemaFile])
	if err != nil {
		return nil, err
	}
	return &Schemas{Catalogue: catalogue, GameSystem: gameSystem}, nil
}

// checkFile reports duplicate keys and schema violations, then decodes the file into target.
func checkFile(schema *jsonschema.Schema, content []byte, target any) []string {
	duplicates, err := duplicateKeys(content)
	if err != nil {
		return []string{"not valid JSON: " + err.Error()}
	}
	var problems []string
	for _, path := range duplicates {
		problems = append(problems, "duplicate key "+path)
	}
	instance, err := jsonschema.UnmarshalJSON(bytes.NewReader(content))
	if err != nil {
		return append(problems, "not valid JSON: "+err.Error())
	}
	if err := schema.Validate(instance); err != nil {
		return append(problems, "does not match the schema: "+err.Error())
	}
	if err := json.Unmarshal(content, target); err != nil {
		return append(problems, err.Error())
	}
	return problems
}

// loadDataset reads game-system.json and catalogues/*.json; it returns no dataset if any file has problems.
func loadDataset(schemas *Schemas, dataDirectory string) (*Dataset, []string, error) {
	dataset := &Dataset{Catalogues: map[string]*Catalogue{}}
	var problems []string
	gameSystemContent, err := os.ReadFile(filepath.Join(dataDirectory, gameSystemFileName))
	if err != nil {
		return nil, nil, err
	}
	for _, problem := range checkFile(schemas.GameSystem, gameSystemContent, &dataset.GameSystem) {
		problems = append(problems, gameSystemFileName+": "+problem)
	}
	cataloguePaths, err := filepath.Glob(filepath.Join(dataDirectory, cataloguesDirectory, "*"+jsonExtension))
	if err != nil {
		return nil, nil, err
	}
	sort.Strings(cataloguePaths)
	for _, cataloguePath := range cataloguePaths {
		content, err := os.ReadFile(cataloguePath)
		if err != nil {
			return nil, nil, err
		}
		fileName := cataloguesDirectory + "/" + filepath.Base(cataloguePath)
		catalogue := &Catalogue{fileName: fileName}
		for _, problem := range checkFile(schemas.Catalogue, content, catalogue) {
			problems = append(problems, fileName+": "+problem)
		}
		dataset.Catalogues[strings.TrimSuffix(filepath.Base(cataloguePath), jsonExtension)] = catalogue
	}
	if len(problems) > 0 {
		return nil, problems, nil
	}
	return dataset, nil, nil
}

// duplicateKeys finds object keys repeated in one object, which encoding/json would silently merge.
func duplicateKeys(content []byte) ([]string, error) {
	decoder := json.NewDecoder(bytes.NewReader(content))
	var duplicates []string
	if err := walkValue(decoder, "", &duplicates); err != nil {
		return nil, err
	}
	return duplicates, nil
}

func walkValue(decoder *json.Decoder, path string, duplicates *[]string) error {
	token, err := decoder.Token()
	if err != nil {
		return err
	}
	delimiter, isDelimiter := token.(json.Delim)
	if !isDelimiter {
		return nil
	}
	if delimiter == '{' {
		seen := map[string]bool{}
		for decoder.More() {
			keyToken, err := decoder.Token()
			if err != nil {
				return err
			}
			key := keyToken.(string)
			if seen[key] {
				*duplicates = append(*duplicates, path+"/"+key)
			}
			seen[key] = true
			if err := walkValue(decoder, path+"/"+key, duplicates); err != nil {
				return err
			}
		}
	} else {
		for index := 0; decoder.More(); index++ {
			if err := walkValue(decoder, fmt.Sprintf("%s/%d", path, index), duplicates); err != nil {
				return err
			}
		}
	}
	_, err = decoder.Token()
	return err
}
