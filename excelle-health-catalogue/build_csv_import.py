# -*- coding: utf-8 -*-
# Genere le fichier CSV pret pour le nouveau bouton "Importer un fichier catalogue" de /admin, a partir des
# memes 71 articles que Catalogue_ExcelleHealth_Vestige.xlsx (reutilise ici pour ne jamais desynchroniser
# les deux fichiers). Separateur point-virgule (convention Excel FR), encode en UTF-8 avec BOM pour un
# affichage correct des accents si le marchand l'ouvre lui-meme dans Excel avant import.
import csv
import importlib.util

spec = importlib.util.spec_from_file_location("build_catalogue", "build_catalogue.py")
mod = importlib.util.module_from_spec(spec)
import sys
sys.modules["build_catalogue"] = mod
# build_catalogue.py ecrit son xlsx des son import (au niveau module) - on l'accepte, c'est sans effet de bord
# problematique (juste re-genere le meme fichier), evite de dupliquer les 71 lignes de donnees ici.
spec.loader.exec_module(mod)

with open("import_ExcelleHealth_Vestige.csv", "w", encoding="utf-8-sig", newline="") as f:
    w = csv.writer(f, delimiter=";")
    w.writerow(["Categorie", "Nom", "Prix", "Stock initial", "Seuil d'alerte", "Couleur", "Taille"])
    for cat, nom, prix, remarque in mod.DONNEES:
        w.writerow([cat, nom, prix, 0, 2, "-", "Unique"])

print("OK -", len(mod.DONNEES), "lignes ecrites")
