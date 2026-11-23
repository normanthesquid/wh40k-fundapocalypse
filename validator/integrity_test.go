package main

import (
	"strings"
	"testing"
)

const (
	agentsID     = "agents-of-the-imperium"
	inquisitorID = "inquisitor"
	factionID    = "example-faction"
	libraryID    = "example-library"
	squadID      = "example-squad"
	hostID       = "example-host"
)

func loadValidDataset(t *testing.T) *Dataset {
	t.Helper()
	dataset, problems, err := loadDataset(mustCompileSchemas(t), validFixtures)
	if err != nil || len(problems) > 0 {
		t.Fatalf("valid fixtures did not load: %v %v", err, problems)
	}
	return dataset
}

func editInquisitor(dataset *Dataset, edit func(*Datasheet)) {
	agents := dataset.Catalogues[agentsID]
	inquisitor := agents.Datasheets[inquisitorID]
	edit(&inquisitor)
	agents.Datasheets[inquisitorID] = inquisitor
}

func editUpgrade(dataset *Dataset, optionIndex int, edit func(*Option)) {
	editInquisitor(dataset, func(inquisitor *Datasheet) {
		edit(&inquisitor.Wargear[1].Options[optionIndex])
	})
}

func pointer[Value any](value Value) *Value {
	return &value
}

func fixed(value int) *Bound {
	return &Bound{Fixed: &value}
}

func count(of CountTarget) *Condition {
	return &Condition{Kind: ConditionKindCount, Of: &of, Minimum: pointer(1)}
}

func setInquisitorCondition(dataset *Dataset, condition *Condition) {
	editInquisitor(dataset, func(inquisitor *Datasheet) { inquisitor.AvailableWhen = condition })
}

func TestIntegrityRules(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*Dataset)
		want   string
	}{
		{"valid fixtures", func(*Dataset) {}, ""},
		{"growing group maximum names a missing option", func(dataset *Dataset) {
			editInquisitor(dataset, func(inquisitor *Datasheet) {
				inquisitor.Wargear[1].Maximum = &Bound{Growing: &Limit{Base: 1, Terms: []LimitTerm{{Per: CountTarget{Kind: CountTargetKindOption, Option: "nope"}}}}}
			})
		}, `wargear/1/maximum/terms/0/per: option "nope" is not an option of its datasheet`},
		{"growing group minimum is not compared statically", func(dataset *Dataset) {
			editInquisitor(dataset, func(inquisitor *Datasheet) {
				term := LimitTerm{Per: CountTarget{Kind: CountTargetKindOption, Option: "psyker"}}
				inquisitor.Wargear[1].Minimum = &Bound{Growing: &Limit{Base: 9, Terms: []LimitTerm{term}}}
			})
		}, ""},
		{"cost change condition is checked", func(dataset *Dataset) {
			editUpgrade(dataset, 0, func(option *Option) {
				option.CostChanges = []CostChange{{When: *count(CountTarget{Kind: CountTargetKindOption, Option: "nope"})}}
			})
		}, `costChanges/0/when/of: option "nope" is not an option of its datasheet`},
		{"option group target resolves", func(dataset *Dataset) {
			setInquisitorCondition(dataset, count(CountTarget{Kind: CountTargetKindOptionGroup, Group: "nope"}))
		}, `option group "nope" is not an option group of its datasheet`},
		{"datasheet cost change condition is checked", func(dataset *Dataset) {
			editInquisitor(dataset, func(inquisitor *Datasheet) {
				inquisitor.CostChanges = []CostChange{{When: *count(CountTarget{Kind: CountTargetKindOption, Option: "nope"})}}
			})
		}, `costChanges/0/when/of: option "nope" is not an option of its datasheet`},
		{"detachment requirement condition is checked", func(dataset *Dataset) {
			editInquisitor(dataset, func(inquisitor *Datasheet) {
				inquisitor.RequiredInDetachment = &DetachmentMinimum{Minimum: 1, When: *count(CountTarget{Kind: CountTargetKindDatasheet, Datasheet: pointer("nope")})}
			})
		}, `requiredInDetachment/when/of: datasheet "nope" does not resolve`},
		{"detachment requirement above the detachment maximum", func(dataset *Dataset) {
			editInquisitor(dataset, func(inquisitor *Datasheet) {
				inquisitor.RequiredInDetachment = &DetachmentMinimum{Minimum: 3, When: *count(CountTarget{Kind: CountTargetKindDatasheet, Datasheet: pointer(inquisitorID)})}
				inquisitor.MaximumPerDetachment = pointer(2)
			})
		}, "requiredInDetachment: minimum 3 is more than maximum 2"},
		{"option required condition is checked", func(dataset *Dataset) {
			editUpgrade(dataset, 0, func(option *Option) {
				option.RequiredWhen = count(CountTarget{Kind: CountTargetKindOption, Option: "nope"})
			})
		}, `requiredWhen/of: option "nope" is not an option of its datasheet`},
		{"growing option maximum names a missing option", func(dataset *Dataset) {
			editUpgrade(dataset, 0, func(option *Option) {
				option.Maximum = &Bound{Growing: &Limit{Base: 1, Terms: []LimitTerm{{Per: CountTarget{Kind: CountTargetKindOption, Option: "nope"}}}}}
			})
		}, `maximum/terms/0/per: option "nope" is not an option of its datasheet`},
		{"added profile reuses a profile name", func(dataset *Dataset) {
			editUpgrade(dataset, 0, func(option *Option) { option.AddsProfiles = []ModelProfile{{Name: "Inquisitor"}} })
		}, `addsProfiles/0: profile name "Inquisitor" is used twice`},
		{"one option adds two models with one name", func(dataset *Dataset) {
			editUpgrade(dataset, 0, func(option *Option) { option.AddsProfiles = []ModelProfile{{Name: "Servitor"}, {Name: "Servitor"}} })
		}, `addsProfiles/1: profile name "Servitor" is used twice`},
		{"alternative options may add models with one name", func(dataset *Dataset) {
			editUpgrade(dataset, 0, func(option *Option) { option.AddsProfiles = []ModelProfile{{Name: "Servitor"}} })
			editUpgrade(dataset, 1, func(option *Option) { option.AddsProfiles = []ModelProfile{{Name: "Servitor"}} })
		}, ""},
		{"conditional change cannot remove only what it adds", func(dataset *Dataset) {
			editInquisitor(dataset, func(inquisitor *Datasheet) {
				inquisitor.Weapons = nil
				weapon := []string{"weapons/master-crafted-weapons"}
				inquisitor.ConditionalChanges = []ConditionalChange{{WargearChanges: WargearChanges{AddsWeapons: weapon, RemovesWeapons: weapon}}}
			})
		}, `conditionalChanges/0/removesWeapons: weapon "weapons/master-crafted-weapons" is not carried`},
		{"profile change may name an added profile", func(dataset *Dataset) {
			editUpgrade(dataset, 0, func(option *Option) {
				option.AddsProfiles = []ModelProfile{{Name: "Servitor"}}
				option.ProfileChanges = []ProfileChange{{Profile: pointer("Servitor")}}
			})
		}, ""},
		{"conditional change removes a weapon nobody carries", func(dataset *Dataset) {
			editInquisitor(dataset, func(inquisitor *Datasheet) {
				inquisitor.Weapons = nil
				inquisitor.ConditionalChanges = []ConditionalChange{{WargearChanges: WargearChanges{RemovesWeapons: []string{"weapons/master-crafted-weapons"}}}}
			})
		}, `conditionalChanges/0/removesWeapons: weapon "weapons/master-crafted-weapons" is not carried`},
		{"conditional change condition is checked", func(dataset *Dataset) {
			editInquisitor(dataset, func(inquisitor *Datasheet) {
				inquisitor.ConditionalChanges = []ConditionalChange{{When: *count(CountTarget{Kind: CountTargetKindDetachment, Detachment: "nope"})}}
			})
		}, `conditionalChanges/0/when/of: detachment "nope"`},
		{"dangling library weapon", func(dataset *Dataset) {
			editInquisitor(dataset, func(inquisitor *Datasheet) { inquisitor.Weapons = []string{"weapons/nope"} })
		}, `inquisitor/weapons: weapon "weapons/nope" does not resolve`},
		{"dangling local weapon", func(dataset *Dataset) {
			editUpgrade(dataset, 0, func(option *Option) { option.AddsWeapons = []string{"nope"} })
		}, `addsWeapons: weapon "nope" does not resolve`},
		{"game system may name any catalogue", func(dataset *Dataset) {
			dataset.Catalogues["weapons"].Abilities = map[string]NamedEntry{"shared": {}}
			battalion := dataset.GameSystem.Detachments["battalion"]
			battalion.Abilities = []string{"weapons/shared"}
			dataset.GameSystem.Detachments["battalion"] = battalion
		}, ""},
		{"reference into a catalogue not imported", func(dataset *Dataset) {
			editInquisitor(dataset, func(inquisitor *Datasheet) { inquisitor.Weapons = []string{libraryID + "/bolter"} })
		}, `which this catalogue does not import`},
		{"reference into a missing catalogue", func(dataset *Dataset) {
			dataset.Catalogues[agentsID].Imports = append(dataset.Catalogues[agentsID].Imports, "ghost")
			editInquisitor(dataset, func(inquisitor *Datasheet) { inquisitor.Weapons = []string{"ghost/bolter"} })
		}, `"ghost/bolter" points into "ghost", which does not exist`},
		{"import of a faction", func(dataset *Dataset) {
			dataset.Catalogues[agentsID].Imports = []string{"weapons", factionID}
		}, `imports: "example-faction" is not a library catalogue`},
		{"dangling ability", func(dataset *Dataset) {
			editInquisitor(dataset, func(inquisitor *Datasheet) { inquisitor.Abilities = []string{"nope"} })
		}, `ability "nope" does not resolve`},
		{"prefixed ability does not fall back to the game system", func(dataset *Dataset) {
			editUpgrade(dataset, 1, func(option *Option) { option.AddsAbilities = []string{"weapons/deep-strike"} })
		}, `ability "weapons/deep-strike" does not resolve`},
		{"library ability", func(dataset *Dataset) {
			dataset.Catalogues["weapons"].Abilities = map[string]NamedEntry{"shared": {}}
			editInquisitor(dataset, func(inquisitor *Datasheet) { inquisitor.Abilities = []string{"weapons/shared"} })
		}, ""},
		{"dangling game-system ability", func(dataset *Dataset) {
			battalion := dataset.GameSystem.Detachments["battalion"]
			battalion.Abilities = []string{"nope"}
			dataset.GameSystem.Detachments["battalion"] = battalion
		}, `battalion/abilities: ability "nope" does not resolve`},
		{"dangling detachment ability", func(dataset *Dataset) {
			dataset.Catalogues[factionID].DetachmentAbilities["example-rally-rule"] = DetachmentAbility{Ability: "nope"}
		}, `example-rally-rule: ability "nope" does not resolve`},
		{"link to a missing datasheet", func(dataset *Dataset) {
			dataset.Catalogues[factionID].DatasheetLinks[squadID] = DatasheetLink{Datasheet: libraryID + "/nope"}
		}, `link target "example-library/nope" does not resolve`},
		{"link to a faction datasheet", func(dataset *Dataset) {
			dataset.Catalogues[agentsID].DatasheetLinks = map[string]DatasheetLink{"local": {Datasheet: inquisitorID}}
		}, `link target "inquisitor" is not in a library catalogue`},
		{"faction-only entries in a library", func(dataset *Dataset) {
			dataset.Catalogues[libraryID].DetachmentAbilities = map[string]DetachmentAbility{"rule": {Ability: "rule"}}
		}, "only factions may have"},
		{"faction-only links in a library", func(dataset *Dataset) {
			dataset.Catalogues[libraryID].DatasheetLinks = map[string]DatasheetLink{"self": {Datasheet: squadID}}
		}, "only factions may have"},
		{"faction-only choices in a library", func(dataset *Dataset) {
			dataset.Catalogues[libraryID].DetachmentChoices = map[string]DetachmentChoice{"filter": {}}
		}, "only factions may have"},
		{"id differs from the file name", func(dataset *Dataset) {
			dataset.Catalogues[agentsID].ID = "agents"
		}, `id "agents" does not match the file name`},
		{"slug used by two kinds of entry", func(dataset *Dataset) {
			dataset.Catalogues[agentsID].Weapons = map[string]NamedEntry{inquisitorID: {}}
		}, `slug "inquisitor" names more than one entry`},
		{"slug shared by two detachment choices' options", func(dataset *Dataset) {
			dataset.Catalogues[agentsID].DetachmentChoices["second"] = DetachmentChoice{Options: map[string]DetachmentChoiceOption{"inquisition": {}}}
		}, `slug "inquisition" names more than one entry`},
		{"game-system slug used twice", func(dataset *Dataset) {
			dataset.GameSystem.Abilities["battalion"] = NamedEntry{}
		}, `game-system.json: slug "battalion" names more than one entry`},
		{"option id repeated in a datasheet", func(dataset *Dataset) {
			editUpgrade(dataset, 0, func(option *Option) { option.ID = "ordo-xenos" })
		}, `id "ordo-xenos" is used twice in this datasheet`},
		{"group id repeated as an option id", func(dataset *Dataset) {
			editUpgrade(dataset, 0, func(option *Option) { option.ID = "ordo" })
		}, `id "ordo" is used twice`},
		{"profile name repeated", func(dataset *Dataset) {
			editInquisitor(dataset, func(inquisitor *Datasheet) {
				inquisitor.Profiles = append(inquisitor.Profiles, inquisitor.Profiles[0])
			})
		}, `profiles/1: profile name "Inquisitor" is used twice`},
		{"unknown detachment", func(dataset *Dataset) {
			setInquisitorCondition(dataset, count(CountTarget{Kind: CountTargetKindDetachment, Detachment: "nope"}))
		}, `detachment "nope" is not a game-system detachment`},
		{"primary faction that is a library", func(dataset *Dataset) {
			setInquisitorCondition(dataset, &Condition{Kind: ConditionKindPrimaryFaction, Faction: libraryID})
		}, `primary faction "example-library" is not a faction catalogue`},
		{"primary faction that does not exist", func(dataset *Dataset) {
			setInquisitorCondition(dataset, &Condition{Kind: ConditionKindPrimaryFaction, Faction: "nope"})
		}, `primary faction "nope"`},
		{"primary faction that is a faction", func(dataset *Dataset) {
			setInquisitorCondition(dataset, &Condition{Kind: ConditionKindPrimaryFaction, Faction: factionID})
		}, ""},
		{"condition nested in All and Not", func(dataset *Dataset) {
			dangling := count(CountTarget{Kind: CountTargetKindDetachment, Detachment: "nope"})
			setInquisitorCondition(dataset, &Condition{Kind: ConditionKindAll, Conditions: []Condition{
				*count(CountTarget{Kind: CountTargetKindAnyUnit}),
				{Kind: ConditionKindNot, Condition: dangling},
			}})
		}, `availableWhen/conditions/1/condition/of: detachment "nope"`},
		{"condition nested in Any", func(dataset *Dataset) {
			setInquisitorCondition(dataset, &Condition{Kind: ConditionKindAny, Conditions: []Condition{
				*count(CountTarget{Kind: CountTargetKindRole}),
				*count(CountTarget{Kind: CountTargetKindDetachment, Detachment: "nope"}),
			}})
		}, `conditions/1/of: detachment "nope"`},
		{"unknown option of the same datasheet", func(dataset *Dataset) {
			setInquisitorCondition(dataset, count(CountTarget{Kind: CountTargetKindOption, Option: "nope"}))
		}, `option "nope" is not an option of its datasheet`},
		{"option of a named datasheet", func(dataset *Dataset) {
			setInquisitorCondition(dataset, count(CountTarget{Kind: CountTargetKindOption, Option: "ordo-xenos", Datasheet: pointer(inquisitorID)}))
		}, ""},
		{"option of a missing datasheet", func(dataset *Dataset) {
			setInquisitorCondition(dataset, count(CountTarget{Kind: CountTargetKindOption, Option: "psyker", Datasheet: pointer("nope")}))
		}, `datasheet "nope" does not resolve`},
		{"option outside any datasheet", func(dataset *Dataset) {
			dataset.Catalogues[factionID].DetachmentAbilities["example-rally-rule"] = DetachmentAbility{
				Ability:       "example-rally",
				AvailableWhen: count(CountTarget{Kind: CountTargetKindOption, Option: "five-models"}),
			}
		}, `option "five-models" names no datasheet, and is not inside one`},
		{"option of a linked library datasheet", func(dataset *Dataset) {
			link := dataset.Catalogues[factionID].DatasheetLinks[squadID]
			link.ConditionalKeywords = []ConditionalKeywords{{When: *count(CountTarget{Kind: CountTargetKindOption, Option: "ten-models"})}}
			dataset.Catalogues[factionID].DatasheetLinks[squadID] = link
		}, ""},
		{"datasheet count through a link", func(dataset *Dataset) {
			dataset.Catalogues[factionID].DetachmentAbilities["example-rally-rule"] = DetachmentAbility{
				Ability:       "example-rally",
				AvailableWhen: count(CountTarget{Kind: CountTargetKindOption, Option: "ten-models", Datasheet: pointer(squadID)}),
			}
		}, ""},
		{"datasheet count of a missing datasheet", func(dataset *Dataset) {
			setInquisitorCondition(dataset, count(CountTarget{Kind: CountTargetKindDatasheet, Datasheet: pointer("nope")}))
		}, `datasheet "nope" does not resolve`},
		{"datasheet count from the game system", func(dataset *Dataset) {
			supreme := dataset.GameSystem.Detachments["supreme-command"]
			supreme.AvailableWhen = count(CountTarget{Kind: CountTargetKindDatasheet, Datasheet: pointer(inquisitorID)})
			dataset.GameSystem.Detachments["supreme-command"] = supreme
		}, `supreme-command/availableWhen/of: datasheet "inquisitor" does not resolve`},
		{"unknown detachment choice option", func(dataset *Dataset) {
			setInquisitorCondition(dataset, count(CountTarget{Kind: CountTargetKindDetachmentChoice, Option: "nope"}))
		}, `detachment choice option "nope" does not resolve`},
		{"detachment choice option from the game system", func(dataset *Dataset) {
			supreme := dataset.GameSystem.Detachments["supreme-command"]
			supreme.AvailableWhen = count(CountTarget{Kind: CountTargetKindDetachmentChoice, Option: "inquisition"})
			dataset.GameSystem.Detachments["supreme-command"] = supreme
		}, `detachment choice option "inquisition" does not resolve`},
		{"detachment choice option in another catalogue", func(dataset *Dataset) {
			supreme := dataset.GameSystem.Detachments["supreme-command"]
			supreme.AvailableWhen = count(CountTarget{Kind: CountTargetKindDetachmentChoice, Option: agentsID + "/inquisition"})
			dataset.GameSystem.Detachments["supreme-command"] = supreme
		}, ""},
		{"keyword nothing adds", func(dataset *Dataset) {
			setInquisitorCondition(dataset, count(CountTarget{Kind: CountTargetKindKeyword, Keyword: "TYPO"}))
		}, `keyword "TYPO" is never added`},
		{"keyword only a faction keyword adds", func(dataset *Dataset) {
			setInquisitorCondition(dataset, count(CountTarget{Kind: CountTargetKindKeyword, Keyword: "IMPERIUM"}))
		}, ""},
		{"keyword only a choice adds", func(dataset *Dataset) {
			dataset.Catalogues[agentsID].DetachmentChoices["faction-filter"].Options["inquisition"] = DetachmentChoiceOption{KeywordChanges: KeywordChanges{AddsKeywords: []string{"FILTERED"}}}
			setInquisitorCondition(dataset, count(CountTarget{Kind: CountTargetKindKeyword, Keyword: "FILTERED"}))
		}, ""},
		{"keyword only a subfaction option names", func(dataset *Dataset) {
			setInquisitorCondition(dataset, count(CountTarget{Kind: CountTargetKindKeyword, Keyword: "FIRST HOST"}))
		}, ""},
		{"placeholder no choice fills", func(dataset *Dataset) {
			delete(dataset.Catalogues[factionID].DetachmentChoices, hostID)
		}, `no detachment choice fills "<EXAMPLE HOST>"`},
		{"placeholder two choices fill", func(dataset *Dataset) {
			dataset.Catalogues[factionID].DetachmentChoices["second-host"] = DetachmentChoice{FillsPlaceholder: pointer("<EXAMPLE HOST>")}
		}, `"<EXAMPLE HOST>" is filled by more than one detachment choice: example-host, second-host`},
		{"subfaction choice no unit needs", func(dataset *Dataset) {
			dataset.Catalogues[factionID].DetachmentChoices["legion"] = DetachmentChoice{FillsPlaceholder: pointer("<LEGION>")}
		}, `detachmentChoices/legion: no unit of this faction carries "<LEGION>"`},
		{"subfaction choice with only your own", func(dataset *Dataset) {
			choice := dataset.Catalogues[factionID].DetachmentChoices[hostID]
			choice.Options = nil
			dataset.Catalogues[factionID].DetachmentChoices[hostID] = choice
		}, ""},
		{"subfaction option without a keyword", func(dataset *Dataset) {
			dataset.Catalogues[factionID].DetachmentChoices[hostID].Options["first-host"] = DetachmentChoiceOption{}
		}, "options/first-host: a subfaction choice's option names its keyword"},
		{"subfaction keyword used by two options", func(dataset *Dataset) {
			dataset.Catalogues[factionID].DetachmentChoices[hostID].Options["second-host"] = DetachmentChoiceOption{Keyword: pointer("FIRST HOST")}
		}, `options/second-host: keyword "FIRST HOST" is already option "first-host"'s`},
		{"plain choice option with a keyword", func(dataset *Dataset) {
			dataset.Catalogues[agentsID].DetachmentChoices["faction-filter"].Options["inquisition"] = DetachmentChoiceOption{Keyword: pointer("INQUISITION")}
		}, "options/inquisition: only a subfaction choice's option names a keyword"},
		{"plain choice with no options", func(dataset *Dataset) {
			dataset.Catalogues[agentsID].DetachmentChoices["faction-filter"] = DetachmentChoice{}
		}, "faction-filter: only a subfaction choice may have no options"},
		{"keyword only a link adds", func(dataset *Dataset) {
			setInquisitorCondition(dataset, count(CountTarget{Kind: CountTargetKindKeyword, Keyword: "EXAMPLE CHAPTER"}))
		}, ""},
		{"keyword only a conditional link keyword adds", func(dataset *Dataset) {
			link := dataset.Catalogues[factionID].DatasheetLinks[squadID]
			link.ConditionalKeywords = []ConditionalKeywords{{
				KeywordChanges: KeywordChanges{AddsKeywords: []string{"VETERAN"}},
				When:           *count(CountTarget{Kind: CountTargetKindAnyUnit}),
			}}
			dataset.Catalogues[factionID].DatasheetLinks[squadID] = link
			setInquisitorCondition(dataset, count(CountTarget{Kind: CountTargetKindKeyword, Keyword: "VETERAN"}))
		}, ""},
		{"default not among the options", func(dataset *Dataset) {
			editInquisitor(dataset, func(inquisitor *Datasheet) { inquisitor.Wargear[0].Default = pointer("psyker") })
		}, `wargear/0: default "psyker" is not one of the group's options`},
		{"group minimum its options cannot meet", func(dataset *Dataset) {
			editInquisitor(dataset, func(inquisitor *Datasheet) { inquisitor.Wargear[1].Minimum = fixed(3) })
		}, `wargear/1: minimum 3 is more than the 2 its options allow`},
		{"group maximum that is not a multiple", func(dataset *Dataset) {
			editInquisitor(dataset, func(inquisitor *Datasheet) {
				inquisitor.Wargear[1].Maximum = fixed(3)
				inquisitor.Wargear[1].MultipleOf = pointer(2)
			})
		}, `wargear/1: maximum 3 is not a multiple of 2`},
		{"group availability condition is checked", func(dataset *Dataset) {
			editInquisitor(dataset, func(inquisitor *Datasheet) {
				inquisitor.Wargear[1].AvailableWhen = count(CountTarget{Kind: CountTargetKindOption, Option: "nope"})
			})
		}, `wargear/1/availableWhen/of: option "nope" is not an option of its datasheet`},
		{"group bounds that are multiples", func(dataset *Dataset) {
			editInquisitor(dataset, func(inquisitor *Datasheet) {
				inquisitor.Wargear[1].Minimum = fixed(2)
				inquisitor.Wargear[1].MultipleOf = pointer(2)
			})
		}, ""},
		{"group minimum its options just meet", func(dataset *Dataset) {
			editInquisitor(dataset, func(inquisitor *Datasheet) { inquisitor.Wargear[1].Minimum = fixed(2) })
		}, ""},
		{"group minimum with an unlimited option", func(dataset *Dataset) {
			editInquisitor(dataset, func(inquisitor *Datasheet) {
				inquisitor.Wargear[1].Minimum = fixed(5)
				inquisitor.Wargear[1].Options[1].Maximum = nil
			})
		}, ""},
		{"removed weapon never carried", func(dataset *Dataset) {
			dataset.Catalogues[agentsID].Weapons = map[string]NamedEntry{"pistol": {}}
			editUpgrade(dataset, 1, func(option *Option) { option.RemovesWeapons = []string{"pistol"} })
		}, `weapon "pistol" is not carried by the datasheet or added by another option`},
		{"removed weapon only this option adds", func(dataset *Dataset) {
			dataset.Catalogues[agentsID].Weapons = map[string]NamedEntry{"pistol": {}}
			editUpgrade(dataset, 1, func(option *Option) {
				option.AddsWeapons = []string{"pistol"}
				option.RemovesWeapons = []string{"pistol"}
			})
		}, `weapon "pistol" is not carried`},
		{"removed weapon the datasheet carries", func(dataset *Dataset) {
			editUpgrade(dataset, 1, func(option *Option) { option.RemovesWeapons = []string{"weapons/master-crafted-weapons"} })
		}, ""},
		{"removed weapon another option adds", func(dataset *Dataset) {
			dataset.Catalogues[agentsID].Weapons = map[string]NamedEntry{"pistol": {}}
			editUpgrade(dataset, 0, func(option *Option) { option.AddsWeapons = []string{"pistol"} })
			editUpgrade(dataset, 1, func(option *Option) { option.RemovesWeapons = []string{"pistol"} })
		}, ""},
		{"a catalogue does not prefix its own entries", func(dataset *Dataset) {
			editInquisitor(dataset, func(inquisitor *Datasheet) { inquisitor.Abilities = []string{agentsID + "/unquestionable-wisdom"} })
		}, "which this catalogue does not import"},
		{"profile change to an unknown profile", func(dataset *Dataset) {
			editUpgrade(dataset, 1, func(option *Option) { option.ProfileChanges[0].Profile = pointer("Nope") })
		}, `profileChanges/0: profile "Nope" is not one of the datasheet's profiles`},
		{"profile change to a known profile", func(dataset *Dataset) {
			editUpgrade(dataset, 1, func(option *Option) { option.ProfileChanges[0].Profile = pointer("Inquisitor") })
		}, ""},
		{"option minimum above maximum", func(dataset *Dataset) {
			editUpgrade(dataset, 0, func(option *Option) { option.Minimum = pointer(2) })
		}, `options/0: minimum 2 is more than maximum 1`},
		{"option minimum equal to maximum", func(dataset *Dataset) {
			editUpgrade(dataset, 0, func(option *Option) { option.Minimum = pointer(1) })
		}, ""},
		{"group minimum above maximum", func(dataset *Dataset) {
			editInquisitor(dataset, func(inquisitor *Datasheet) { inquisitor.Wargear[0].Minimum = fixed(2) })
		}, `wargear/0: minimum 2 is more than maximum 1`},
		{"count minimum above maximum", func(dataset *Dataset) {
			condition := count(CountTarget{Kind: CountTargetKindAnyUnit})
			condition.Minimum, condition.Maximum = pointer(3), pointer(2)
			setInquisitorCondition(dataset, condition)
		}, `availableWhen: minimum 3 is more than maximum 2`},
		{"detachment choice minimum above maximum", func(dataset *Dataset) {
			choice := dataset.Catalogues[agentsID].DetachmentChoices["faction-filter"]
			choice.Minimum = pointer(2)
			dataset.Catalogues[agentsID].DetachmentChoices["faction-filter"] = choice
		}, `detachmentChoices/faction-filter: minimum 2 is more than maximum 1`},
		{"movement range minimum above maximum", func(dataset *Dataset) {
			editInquisitor(dataset, func(inquisitor *Datasheet) {
				inquisitor.Profiles[0].Movement = Movement{Kind: MovementKindRange, Minimum: 60, Maximum: 20}
			})
		}, `profiles/0/movement: minimum 60 is more than maximum 20`},
		{"inches movement ignores range fields", func(dataset *Dataset) {
			editInquisitor(dataset, func(inquisitor *Datasheet) {
				inquisitor.Profiles[0].Movement = Movement{Kind: MovementKindInches, Minimum: 60, Maximum: 20}
			})
		}, ""},
		{"profile change movement range minimum above maximum", func(dataset *Dataset) {
			editUpgrade(dataset, 1, func(option *Option) {
				option.ProfileChanges[0].Set.Movement = &Movement{Kind: MovementKindRange, Minimum: 9, Maximum: 8}
			})
		}, `profileChanges/0/set/movement: minimum 9 is more than maximum 8`},
		{"slot minimum above a fixed maximum", func(dataset *Dataset) {
			battalion := dataset.GameSystem.Detachments["battalion"]
			battalion.Slots["HQ"] = BoundedLimit{Minimum: pointer(4), Maximum: &Limit{Base: 3}}
			dataset.GameSystem.Detachments["battalion"] = battalion
		}, `battalion/slots/HQ: minimum 4 is more than maximum 3`},
		{"slot minimum against a growing maximum", func(dataset *Dataset) {
			battalion := dataset.GameSystem.Detachments["battalion"]
			slot := battalion.Slots["DedicatedTransport"]
			slot.Minimum = pointer(1)
			battalion.Slots["DedicatedTransport"] = slot
			dataset.GameSystem.Detachments["battalion"] = battalion
		}, ""},
		{"limit term counting an unknown detachment", func(dataset *Dataset) {
			battalion := dataset.GameSystem.Detachments["battalion"]
			battalion.Slots["HQ"] = BoundedLimit{Maximum: &Limit{Terms: []LimitTerm{{Per: CountTarget{Kind: CountTargetKindDetachment, Detachment: "nope"}}}}}
			dataset.GameSystem.Detachments["battalion"] = battalion
		}, `slots/HQ/maximum/terms/0/per: detachment "nope"`},
		{"alternative role counting an unknown detachment", func(dataset *Dataset) {
			editInquisitor(dataset, func(inquisitor *Datasheet) {
				inquisitor.AlternativeRoles = []AlternativeRole{{When: *count(CountTarget{Kind: CountTargetKindDetachment, Detachment: "nope"})}}
			})
		}, `alternativeRoles/0/when/of: detachment "nope"`},
		{"link availability counting an unknown detachment", func(dataset *Dataset) {
			link := dataset.Catalogues[factionID].DatasheetLinks[squadID]
			link.AvailableWhen = count(CountTarget{Kind: CountTargetKindDetachment, Detachment: "nope"})
			dataset.Catalogues[factionID].DatasheetLinks[squadID] = link
		}, `example-squad/availableWhen/of: detachment "nope"`},
		{"link ability that does not resolve", func(dataset *Dataset) {
			link := dataset.Catalogues[factionID].DatasheetLinks[squadID]
			link.AddsAbilities = []string{"nope"}
			dataset.Catalogues[factionID].DatasheetLinks[squadID] = link
		}, `example-squad/addsAbilities: ability "nope" does not resolve`},
		{"detachment availability counting an unknown detachment", func(dataset *Dataset) {
			dataset.Catalogues[factionID].DetachmentAbilities["example-rally-rule"] = DetachmentAbility{
				Ability:       "example-rally",
				AvailableWhen: count(CountTarget{Kind: CountTargetKindDetachment, Detachment: "nope"}),
			}
		}, `example-rally-rule/availableWhen/of: detachment "nope"`},
		{"library importing itself", func(dataset *Dataset) {
			dataset.Catalogues[libraryID].Imports = []string{libraryID}
		}, "a catalogue does not import itself"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			dataset := loadValidDataset(t)
			test.mutate(dataset)
			problems := checkIntegrity(dataset, nil)
			joined := strings.Join(problems, "\n")
			if test.want == "" {
				if len(problems) > 0 {
					t.Fatalf("want no problems, got:\n%s", joined)
				}
				return
			}
			if !strings.Contains(joined, test.want) {
				t.Fatalf("want a problem containing %q, got:\n%s", test.want, joined)
			}
		})
	}
}

func TestReleaseMustMatchTheTag(t *testing.T) {
	dataset := loadValidDataset(t)
	if problems := checkIntegrity(dataset, pointer(fixtureRelease)); len(problems) > 0 {
		t.Fatalf("matching release reported: %v", problems)
	}
	problems := checkIntegrity(dataset, pointer("2.0.1"))
	if len(problems) != 1 || !strings.Contains(problems[0], `release "2.0.0" does not match the tag's "2.0.1"`) {
		t.Fatalf("got %v", problems)
	}
}

func TestEachDuplicateSlugIsReportedOnce(t *testing.T) {
	dataset := loadValidDataset(t)
	dataset.Catalogues[agentsID].Weapons = map[string]NamedEntry{inquisitorID: {}}
	dataset.Catalogues[agentsID].Abilities[inquisitorID] = NamedEntry{}
	problems := checkIntegrity(dataset, nil)
	if len(problems) != 1 {
		t.Fatalf("want one problem, got %v", problems)
	}
}

func TestBrokenLinkIsReportedOnce(t *testing.T) {
	dataset := loadValidDataset(t)
	dataset.Catalogues[factionID].DatasheetLinks[squadID] = DatasheetLink{Datasheet: libraryID + "/nope"}
	dataset.Catalogues[factionID].DetachmentAbilities["example-rally-rule"] = DetachmentAbility{
		Ability:       "example-rally",
		AvailableWhen: count(CountTarget{Kind: CountTargetKindDatasheet, Datasheet: pointer(squadID)}),
	}
	if problems := checkIntegrity(dataset, nil); len(problems) != 1 {
		t.Fatalf("want one problem, got %v", problems)
	}
}

func TestUnusedKeywordIsReportedAtEveryUse(t *testing.T) {
	dataset := loadValidDataset(t)
	supreme := dataset.GameSystem.Detachments["supreme-command"]
	supreme.AvailableWhen = count(CountTarget{Kind: CountTargetKindKeyword, Keyword: "TYPO"})
	dataset.GameSystem.Detachments["supreme-command"] = supreme
	setInquisitorCondition(dataset, count(CountTarget{Kind: CountTargetKindKeyword, Keyword: "TYPO"}))
	if problems := checkIntegrity(dataset, nil); len(problems) != 2 {
		t.Fatalf("want two problems, got %v", problems)
	}
}
