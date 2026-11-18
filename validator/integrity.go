package main

import (
	"maps"
	"slices"
	"strings"
)

// checkIntegrity applies the cross-entry rules in docs/data-format.md, "Integrity rules".
// expectedRelease is the tag being released, when there is one (rule 9).
func checkIntegrity(dataset *Dataset, expectedRelease *string) []string {
	check := &checker{dataset: dataset, usedKeywords: map[string][]string{}, addedKeywords: map[string]bool{}}
	check.checkGameSystem()
	for _, catalogueID := range sortedKeys(dataset.Catalogues) {
		check.checkCatalogue(catalogueID, dataset.Catalogues[catalogueID])
	}
	for _, keyword := range sortedKeys(check.usedKeywords) {
		if !check.addedKeywords[keyword] {
			for _, location := range check.usedKeywords[keyword] {
				check.report(scope{location: location}, "keyword %q is never added by a datasheet, option, link or choice", keyword)
			}
		}
	}
	if expectedRelease != nil && dataset.GameSystem.Release != *expectedRelease {
		check.report(scope{location: gameSystemFileName}, "release %q does not match the tag's %q", dataset.GameSystem.Release, *expectedRelease)
	}
	return check.problems
}

func (check *checker) checkGameSystem() {
	gameSystem := check.dataset.GameSystem
	where := scope{location: gameSystemFileName}
	check.checkUniqueSlugs(where, sortedKeys(gameSystem.Detachments), sortedKeys(gameSystem.UniversalOptions),
		sortedKeys(gameSystem.Abilities), sortedKeys(gameSystem.WarmasterTraits))
	for _, slug := range sortedKeys(gameSystem.Detachments) {
		detachment := gameSystem.Detachments[slug]
		detachmentScope := where.at("detachments/%s", slug)
		check.checkLimit(detachmentScope.at("maximumPerArmy"), detachment.MaximumPerArmy)
		check.checkCondition(detachmentScope.at("availableWhen"), detachment.AvailableWhen)
		for _, role := range sortedKeys(detachment.Slots) {
			check.checkBoundedLimit(detachmentScope.at("slots/%s", role), detachment.Slots[role])
		}
		check.checkKeywordLimits(detachmentScope.at("keywordLimits"), detachment.KeywordLimits)
		for _, ability := range detachment.Abilities {
			check.checkAbility(detachmentScope.at("abilities"), ability)
		}
	}
	for _, slug := range sortedKeys(gameSystem.UniversalOptions) {
		option := gameSystem.UniversalOptions[slug]
		optionScope := where.at("universalOptions/%s", slug)
		if option.ID != nil && *option.ID != slug {
			check.report(optionScope, "id %q differs from its key", *option.ID)
		}
		check.checkOption(optionScope, option.Option)
	}
	check.checkKeywordLimits(where.at("armyKeywordLimits"), gameSystem.ArmyKeywordLimits)
}

func (check *checker) checkKeywordLimits(where scope, limits map[string]BoundedLimit) {
	for _, keyword := range sortedKeys(limits) {
		keywordScope := where.at("%s", keyword)
		check.useKeyword(keywordScope, keyword)
		check.checkBoundedLimit(keywordScope, limits[keyword])
	}
}

func (check *checker) checkCatalogue(catalogueID string, catalogue *Catalogue) {
	where := scope{catalogue: catalogue, location: catalogue.fileName}
	if catalogue.ID != catalogueID {
		check.report(where, "id %q does not match the file name", catalogue.ID)
	}
	for _, imported := range catalogue.Imports {
		target, exists := check.dataset.Catalogues[imported]
		if !exists || target.Kind != CatalogueKindLibrary {
			check.report(where.at("imports"), "%q is not a library catalogue", imported)
		}
		if imported == catalogueID {
			check.report(where.at("imports"), "a catalogue does not import itself")
		}
	}
	var choiceOptions []string
	for _, slug := range sortedKeys(catalogue.DetachmentChoices) {
		choiceOptions = append(choiceOptions, sortedKeys(catalogue.DetachmentChoices[slug].Options)...)
	}
	check.checkUniqueSlugs(where, sortedKeys(catalogue.Datasheets), sortedKeys(catalogue.DatasheetLinks),
		sortedKeys(catalogue.DetachmentChoices), choiceOptions, sortedKeys(catalogue.DetachmentAbilities),
		sortedKeys(catalogue.Weapons), sortedKeys(catalogue.Abilities), sortedKeys(catalogue.WarmasterTraits))
	if catalogue.Kind == CatalogueKindLibrary {
		hasFactionOnlyEntries := len(catalogue.DatasheetLinks) > 0 || len(catalogue.DetachmentChoices) > 0 || len(catalogue.DetachmentAbilities) > 0
		if hasFactionOnlyEntries {
			check.report(where, "a library has datasheetLinks, detachmentChoices or detachmentAbilities, which only factions may have")
		}
	}
	for _, slug := range sortedKeys(catalogue.Datasheets) {
		datasheet := catalogue.Datasheets[slug]
		check.checkDatasheet(scope{catalogue: catalogue, datasheet: &datasheet, location: where.location + "/datasheets/" + slug})
	}
	for _, slug := range sortedKeys(catalogue.DatasheetLinks) {
		check.checkDatasheetLink(where.at("datasheetLinks/%s", slug), catalogue.DatasheetLinks[slug])
	}
	for _, slug := range sortedKeys(catalogue.DetachmentChoices) {
		choice := catalogue.DetachmentChoices[slug]
		check.checkBounds(where.at("detachmentChoices/%s", slug), choice.Minimum, choice.Maximum)
		for _, option := range choice.Options {
			check.addKeywords(option)
		}
	}
	for _, slug := range sortedKeys(catalogue.DetachmentAbilities) {
		ability := catalogue.DetachmentAbilities[slug]
		abilityScope := where.at("detachmentAbilities/%s", slug)
		check.checkAbility(abilityScope, ability.Ability)
		check.checkCondition(abilityScope.at("availableWhen"), ability.AvailableWhen)
	}
}

func (check *checker) checkDatasheet(where scope) {
	datasheet := where.datasheet
	check.addKeywords(KeywordChanges{AddsFactionKeywords: datasheet.FactionKeywords, AddsKeywords: datasheet.Keywords})
	profileNames := map[string]bool{}
	for index, profile := range datasheet.Profiles {
		if profileNames[profile.Name] {
			check.report(where.at("profiles/%d", index), "profile name %q is used twice", profile.Name)
		}
		profileNames[profile.Name] = true
		check.checkMovement(where.at("profiles/%d/movement", index), profile.Movement)
	}
	for groupIndex, group := range datasheet.Wargear {
		for optionIndex, option := range group.Options {
			check.checkAddedProfiles(where.at("wargear/%d/options/%d", groupIndex, optionIndex), option.AddsProfiles, profileNames)
		}
	}
	for _, weapon := range datasheet.Weapons {
		check.checkWeapon(where.at("weapons"), weapon)
	}
	for _, ability := range datasheet.Abilities {
		check.checkAbility(where.at("abilities"), ability)
	}
	check.checkAlternativeRoles(where, datasheet.AlternativeRoles)
	check.checkCondition(where.at("availableWhen"), datasheet.AvailableWhen)
	for index := range datasheet.CostChanges {
		check.checkCondition(where.at("costChanges/%d/when", index), &datasheet.CostChanges[index].When)
	}
	for index, change := range datasheet.ConditionalChanges {
		changeScope := where.at("conditionalChanges/%d", index)
		check.checkWargearChanges(changeScope, change.WargearChanges, carrier{conditionalChange: index})
		check.checkCondition(changeScope.at("when"), &change.When)
	}
	seenIDs := map[string]bool{}
	for groupIndex, group := range datasheet.Wargear {
		groupScope := where.at("wargear/%d", groupIndex)
		for _, identifier := range append([]string{group.ID}, optionIDsOf(group)...) {
			if seenIDs[identifier] {
				check.report(groupScope, "id %q is used twice in this datasheet", identifier)
			}
			seenIDs[identifier] = true
		}
		check.checkOptionGroup(groupScope, group)
		for optionIndex, option := range group.Options {
			check.checkOption(groupScope.at("options/%d", optionIndex), option)
		}
	}
}

// checkOptionGroup is rule 6: the default is an option, and the options can meet the minimum.
// checkAddedProfiles keeps an option's added models apart from the datasheet's own profiles and from each other.
// Alternative options may add models with the same name, e.g. two kinds of Sergeant.
func (check *checker) checkAddedProfiles(where scope, profiles []ModelProfile, datasheetProfiles map[string]bool) {
	added := map[string]bool{}
	for index, profile := range profiles {
		profileScope := where.at("addsProfiles/%d", index)
		if datasheetProfiles[profile.Name] || added[profile.Name] {
			check.report(profileScope, "profile name %q is used twice", profile.Name)
		}
		added[profile.Name] = true
		check.checkMovement(profileScope.at("movement"), profile.Movement)
	}
}

func (check *checker) checkOptionGroup(where scope, group OptionGroup) {
	minimum, maximum := fixedBound(group.Minimum), fixedBound(group.Maximum)
	check.checkBounds(where, minimum, maximum)
	if group.Minimum != nil {
		check.checkLimit(where.at("minimum"), group.Minimum.Growing)
	}
	if group.Maximum != nil {
		check.checkLimit(where.at("maximum"), group.Maximum.Growing)
	}
	if group.Default != nil && !slices.Contains(optionIDsOf(group), *group.Default) {
		check.report(where, "default %q is not one of the group's options", *group.Default)
	}
	if minimum == nil {
		return
	}
	available := 0
	for _, option := range group.Options {
		maximum := fixedBound(option.Maximum)
		if maximum == nil {
			return
		}
		available += *maximum
	}
	if *minimum > available {
		check.report(where, "minimum %d is more than the %d its options allow", *minimum, available)
	}
}

// fixedBound is a bound's number when it is fixed; a growing one is only known for a given army.
func fixedBound(bound *Bound) *int {
	if bound == nil {
		return nil
	}
	return bound.Fixed
}

func (check *checker) checkOption(where scope, option Option) {
	check.checkBounds(where, option.Minimum, fixedBound(option.Maximum))
	if option.Maximum != nil {
		check.checkLimit(where.at("maximum"), option.Maximum.Growing)
	}
	check.checkBounds(where.at("minimumPerArmy"), option.MinimumPerArmy, option.MaximumPerArmy)
	for index := range option.CostChanges {
		check.checkCondition(where.at("costChanges/%d/when", index), &option.CostChanges[index].When)
	}
	check.checkWargearChanges(where, option.WargearChanges, carrier{option: option.ID, conditionalChange: noConditionalChange})
	check.checkCondition(where.at("availableWhen"), option.AvailableWhen)
	check.checkCondition(where.at("requiredWhen"), option.RequiredWhen)
}

// noConditionalChange is a carrier index no conditional change has.
const noConditionalChange = -1

// carrier is the option or conditional change whose own added weapons don't count towards what it removes.
type carrier struct {
	option            string
	conditionalChange int
}

// checkWargearChanges checks what an option or a conditional change adds and removes.
func (check *checker) checkWargearChanges(where scope, changes WargearChanges, itself carrier) {
	check.addKeywords(changes.KeywordChanges)
	for _, weapon := range changes.AddsWeapons {
		check.checkWeapon(where.at("addsWeapons"), weapon)
	}
	for _, weapon := range changes.RemovesWeapons {
		check.checkWeapon(where.at("removesWeapons"), weapon)
		if where.datasheet != nil && !slices.Contains(check.carriedWeapons(where, itself), check.weaponID(where, weapon)) {
			check.report(where.at("removesWeapons"), "weapon %q is not carried by the datasheet or added by another option or conditional change", weapon)
		}
	}
	for _, ability := range changes.AddsAbilities {
		check.checkAbility(where.at("addsAbilities"), ability)
	}
	for index, change := range changes.ProfileChanges {
		changeScope := where.at("profileChanges/%d", index)
		if change.Profile != nil && where.datasheet != nil && !hasProfile(where.datasheet, *change.Profile) {
			check.report(changeScope, "profile %q is not one of the datasheet's profiles", *change.Profile)
		}
		if change.Set != nil && change.Set.Movement != nil {
			check.checkMovement(changeScope.at("set/movement"), *change.Set.Movement)
		}
	}
}

// carriedWeapons is rule 7's set: the datasheet's weapons and those its other options add, as catalogue-id/slug.
func (check *checker) carriedWeapons(where scope, itself carrier) []string {
	var weapons []string
	for _, weapon := range where.datasheet.Weapons {
		weapons = append(weapons, check.weaponID(where, weapon))
	}
	for _, group := range where.datasheet.Wargear {
		for _, option := range group.Options {
			if option.ID == itself.option {
				continue
			}
			for _, weapon := range option.AddsWeapons {
				weapons = append(weapons, check.weaponID(where, weapon))
			}
		}
	}
	for index, change := range where.datasheet.ConditionalChanges {
		if index == itself.conditionalChange {
			continue
		}
		for _, weapon := range change.AddsWeapons {
			weapons = append(weapons, check.weaponID(where, weapon))
		}
	}
	return weapons
}

func (check *checker) weaponID(where scope, reference string) string {
	if strings.Contains(reference, "/") {
		return reference
	}
	return where.catalogue.ID + "/" + reference
}

func (check *checker) checkDatasheetLink(where scope, link DatasheetLink) {
	check.addKeywords(link.KeywordChanges)
	where.datasheet = check.linkedDatasheet(where, link)
	for _, ability := range link.AddsAbilities {
		check.checkAbility(where.at("addsAbilities"), ability)
	}
	check.checkAlternativeRoles(where, link.AlternativeRoles)
	for index, conditional := range link.ConditionalKeywords {
		check.addKeywords(conditional.KeywordChanges)
		check.checkCondition(where.at("conditionalKeywords/%d/when", index), &conditional.When)
	}
	check.checkCondition(where.at("availableWhen"), link.AvailableWhen)
}

func (check *checker) checkAlternativeRoles(where scope, roles []AlternativeRole) {
	for index, role := range roles {
		check.checkCondition(where.at("alternativeRoles/%d/when", index), &role.When)
	}
}

func (check *checker) checkMovement(where scope, movement Movement) {
	if movement.Kind == MovementKindRange {
		check.checkBounds(where, &movement.Minimum, &movement.Maximum)
	}
}

// checkUniqueSlugs is rule 1: one slug names one entry across every kind of entry in a file.
func (check *checker) checkUniqueSlugs(where scope, slugLists ...[]string) {
	seen := map[string]bool{}
	reported := map[string]bool{}
	for _, slugs := range slugLists {
		for _, slug := range slugs {
			if seen[slug] && !reported[slug] {
				check.report(where, "slug %q names more than one entry", slug)
				reported[slug] = true
			}
			seen[slug] = true
		}
	}
}

func sortedKeys[Value any](entries map[string]Value) []string {
	return slices.Sorted(maps.Keys(entries))
}

func optionIDsOf(group OptionGroup) []string {
	return optionIDs(&Datasheet{Wargear: []OptionGroup{group}})
}

func hasProfile(datasheet *Datasheet, name string) bool {
	for _, profile := range datasheet.Profiles {
		if profile.Name == name {
			return true
		}
	}
	for _, group := range datasheet.Wargear {
		for _, option := range group.Options {
			for _, profile := range option.AddsProfiles {
				if profile.Name == name {
					return true
				}
			}
		}
	}
	return false
}
