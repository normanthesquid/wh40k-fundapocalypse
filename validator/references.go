package main

import (
	"fmt"
	"slices"
	"strings"
)

// scope is where a reference or condition appears. catalogue is nil in the
// game system; datasheet is the unit whose options a bare Option count names.
type scope struct {
	catalogue *Catalogue
	datasheet *Datasheet
	location  string
}

func (current scope) at(format string, arguments ...any) scope {
	current.location = current.location + "/" + fmt.Sprintf(format, arguments...)
	return current
}

type checker struct {
	dataset       *Dataset
	problems      []string
	usedKeywords  map[string][]string
	addedKeywords map[string]bool
}

func (check *checker) report(where scope, format string, arguments ...any) {
	check.problems = append(check.problems, where.location+": "+fmt.Sprintf(format, arguments...))
}

// targetCatalogue splits a reference into the catalogue it points into and its
// slug. A bare slug stays in the current catalogue (nil in the game system).
// The game system has no imports, so its prefixed references may name any catalogue.
func (check *checker) targetCatalogue(where scope, reference string) (*Catalogue, string, bool) {
	catalogueID, slug, isPrefixed := strings.Cut(reference, "/")
	if !isPrefixed {
		return where.catalogue, reference, true
	}
	if where.catalogue != nil && !slices.Contains(where.catalogue.Imports, catalogueID) {
		check.report(where, "%q points into %q, which this catalogue does not import", reference, catalogueID)
		return nil, "", false
	}
	target, exists := check.dataset.Catalogues[catalogueID]
	if !exists {
		check.report(where, "%q points into %q, which does not exist", reference, catalogueID)
		return nil, "", false
	}
	return target, slug, true
}

func (check *checker) checkWeapon(where scope, reference string) {
	target, slug, found := check.targetCatalogue(where, reference)
	if !found {
		return
	}
	if _, exists := target.Weapons[slug]; !exists {
		check.report(where, "weapon %q does not resolve", reference)
	}
}

// checkAbility resolves an ability; a bare slug may also name a game-system ability.
func (check *checker) checkAbility(where scope, reference string) {
	target, slug, found := check.targetCatalogue(where, reference)
	if !found {
		return
	}
	if target != nil {
		if _, exists := target.Abilities[slug]; exists {
			return
		}
	}
	if _, exists := check.dataset.GameSystem.Abilities[slug]; exists && target == where.catalogue {
		return
	}
	check.report(where, "ability %q does not resolve", reference)
}

// resolveDatasheet finds a datasheet, following a datasheet link to the library datasheet it fields.
func (check *checker) resolveDatasheet(where scope, reference string) *Datasheet {
	target, slug, found := check.targetCatalogue(where, reference)
	if !found {
		return nil
	}
	if target != nil {
		if datasheet, exists := target.Datasheets[slug]; exists {
			return &datasheet
		}
		if link, exists := target.DatasheetLinks[slug]; exists {
			// The link's own check already reports a broken target, so report nothing twice here.
			silent := &checker{dataset: check.dataset}
			return silent.linkedDatasheet(scope{catalogue: target, location: where.location}, link)
		}
	}
	check.report(where, "datasheet %q does not resolve", reference)
	return nil
}

// linkedDatasheet returns the library datasheet a link fields, or reports why it can't.
func (check *checker) linkedDatasheet(where scope, link DatasheetLink) *Datasheet {
	target, slug, found := check.targetCatalogue(where, link.Datasheet)
	if !found {
		return nil
	}
	if target == nil || target.Kind != CatalogueKindLibrary {
		check.report(where, "link target %q is not in a library catalogue", link.Datasheet)
		return nil
	}
	datasheet, exists := target.Datasheets[slug]
	if !exists {
		check.report(where, "link target %q does not resolve", link.Datasheet)
		return nil
	}
	return &datasheet
}

func (check *checker) checkCondition(where scope, condition *Condition) {
	if condition == nil {
		return
	}
	switch condition.Kind {
	case ConditionKindCount:
		check.checkBounds(where, condition.Minimum, condition.Maximum)
		check.checkCountTarget(where.at("of"), *condition.Of)
	case ConditionKindPrimaryFaction:
		faction, exists := check.dataset.Catalogues[condition.Faction]
		if !exists || faction.Kind != CatalogueKindFaction {
			check.report(where, "primary faction %q is not a faction catalogue", condition.Faction)
		}
	case ConditionKindAll, ConditionKindAny:
		for index := range condition.Conditions {
			check.checkCondition(where.at("conditions/%d", index), &condition.Conditions[index])
		}
	case ConditionKindNot:
		check.checkCondition(where.at("condition"), condition.Condition)
	}
}

func (check *checker) checkLimit(where scope, limit *Limit) {
	if limit == nil {
		return
	}
	for index, term := range limit.Terms {
		check.checkCountTarget(where.at("terms/%d/per", index), term.Per)
	}
}

func (check *checker) checkCountTarget(where scope, target CountTarget) {
	switch target.Kind {
	case CountTargetKindDatasheet:
		check.resolveDatasheet(where, *target.Datasheet)
	case CountTargetKindKeyword:
		check.useKeyword(where, target.Keyword)
	case CountTargetKindOption:
		check.checkOptionTarget(where, target)
	case CountTargetKindOptionGroup:
		check.checkOptionGroupTarget(where, target.Group)
	case CountTargetKindDetachmentChoice:
		check.checkDetachmentChoiceTarget(where, target.Option)
	case CountTargetKindDetachment:
		if _, exists := check.dataset.GameSystem.Detachments[target.Detachment]; !exists {
			check.report(where, "detachment %q is not a game-system detachment", target.Detachment)
		}
	case CountTargetKindRole, CountTargetKindDetachmentKind, CountTargetKindAnyUnit:
	}
}

func (check *checker) checkOptionTarget(where scope, target CountTarget) {
	datasheet := where.datasheet
	if target.Datasheet != nil {
		datasheet = check.resolveDatasheet(where, *target.Datasheet)
		if datasheet == nil {
			return
		}
	}
	if datasheet == nil {
		check.report(where, "option %q names no datasheet, and is not inside one", target.Option)
		return
	}
	if !slices.Contains(optionIDs(datasheet), target.Option) {
		check.report(where, "option %q is not an option of its datasheet", target.Option)
	}
}

func (check *checker) checkOptionGroupTarget(where scope, group string) {
	if where.datasheet == nil {
		check.report(where, "option group %q is not inside a datasheet", group)
		return
	}
	for _, candidate := range where.datasheet.Wargear {
		if candidate.ID == group {
			return
		}
	}
	check.report(where, "option group %q is not an option group of its datasheet", group)
}

func (check *checker) checkDetachmentChoiceTarget(where scope, reference string) {
	target, slug, found := check.targetCatalogue(where, reference)
	if !found {
		return
	}
	if target != nil {
		for _, choice := range target.DetachmentChoices {
			if _, exists := choice.Options[slug]; !exists {
				continue
			}
			// Each unit names its own subfaction, so a condition on one tests the unit's keyword (rule 10).
			if choice.FillsPlaceholder != nil {
				check.report(where, "detachment choice option %q is a subfaction: count its keyword in the unit", reference)
			}
			return
		}
	}
	check.report(where, "detachment choice option %q does not resolve", reference)
}

func (check *checker) useKeyword(where scope, keyword string) {
	check.usedKeywords[keyword] = append(check.usedKeywords[keyword], where.location)
}

func (check *checker) addKeywords(changes KeywordChanges) {
	for _, keyword := range changes.AddsFactionKeywords {
		check.addedKeywords[keyword] = true
	}
	for _, keyword := range changes.AddsKeywords {
		check.addedKeywords[keyword] = true
	}
}

// checkBounds is rule 8: a minimum never exceeds its maximum.
func (check *checker) checkBounds(where scope, minimum *int, maximum *int) {
	if minimum != nil && maximum != nil && *minimum > *maximum {
		check.report(where, "minimum %d is more than maximum %d", *minimum, *maximum)
	}
}

// checkBoundedLimit compares the minimum with a maximum that has no terms, the only case known statically.
func (check *checker) checkBoundedLimit(where scope, limit BoundedLimit) {
	if limit.Maximum != nil && len(limit.Maximum.Terms) == 0 {
		check.checkBounds(where, limit.Minimum, &limit.Maximum.Base)
	}
	check.checkLimit(where.at("maximum"), limit.Maximum)
}

func optionIDs(datasheet *Datasheet) []string {
	var identifiers []string
	for _, group := range datasheet.Wargear {
		for _, option := range group.Options {
			identifiers = append(identifiers, option.ID)
		}
	}
	return identifiers
}
